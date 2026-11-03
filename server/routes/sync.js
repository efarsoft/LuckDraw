'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const state = require('../services/state');
const usersSvc = require('../services/users');
const avatarLib = require('../lib/avatar');

/**
 * 云端侧同步端点（PAIR_KEY 鉴权）：
 *  - GET  /api/sync/pull       本地节点增量拉取签到用户（数据回流）
 *  - GET  /api/sync/avatar     拉取已落盘的头像文件
 *  - POST /api/sync/push       接收本地快照（rounds/winners/手动用户/设置），幂等全量应用
 *  - POST /api/sync/heartbeat  心跳，供手机端展示数据新鲜度
 */
const router = express.Router();

function requirePair(req, res, next) {
  const key = req.headers['x-pair-key'] || '';
  if (!config.PAIR_KEY || key !== config.PAIR_KEY) return res.status(401).json({ error: 'pair key invalid' });
  next();
}

router.get('/api/sync/pull', requirePair, (req, res) => {
  const since = parseInt(req.query.since_id || '0', 10) || 0;
  const users = db
    .prepare(
      `SELECT id, openid, nickname, avatar, source, note, real_name, phone, dept, joined_at FROM users
       WHERE id > ? AND id > 0 ORDER BY id ASC LIMIT 500`
    )
    .all(since);
  res.json({ users, server_time: Date.now() });
});

router.get('/api/sync/avatar', requirePair, (req, res) => {
  const file = String(req.query.file || '');
  const buf = avatarLib.readAvatarFile(file);
  if (!buf) return res.status(404).json({ error: 'avatar not found' });
  const ext = file.endsWith('.svg') ? 'svg' : file.endsWith('.png') ? 'png' : 'jpeg';
  res.setHeader('Content-Type', `image/${ext === 'svg' ? 'svg+xml' : ext}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buf);
});

const OWNED_KEYS = ['activity_title', 'activity_subtitle', 'sign_in_enabled', 'current_round_id', 'phase', 'group_reveal_threshold'];

router.post('/api/sync/push', requirePair, (req, res) => {
  const snap = req.body || {};
  if (!Array.isArray(snap.rounds) || !Array.isArray(snap.winners)) {
    return res.status(400).json({ error: '快照格式错误' });
  }
  db.transaction(() => {
    // 全量替换本地-owned 实体（数据量小，幂等且能正确处理回滚/删除）
    db.prepare('DELETE FROM rounds').run();
    db.prepare('DELETE FROM winners').run();
    const insRound = db.prepare(
      `INSERT INTO rounds(id, seq, name, prize_name, prize_image, winner_count, status, created_at, drawn_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    );
    for (const r of snap.rounds) {
      insRound.run(
        r.id, r.seq, r.name, r.prize_name, r.prize_image || null, r.winner_count,
        r.status, r.created_at, r.drawn_at || null
      );
    }
    const insWinner = db.prepare(
      `INSERT INTO winners(id, round_id, user_id, status, won_at) VALUES(?,?,?,?,?)`
    );
    for (const w of snap.winners) {
      insWinner.run(w.id, w.round_id, w.user_id, w.status, w.won_at);
    }
    if (snap.clear_users) {
      db.prepare('DELETE FROM users').run(); // 本地全量重置 → 云端签到与补录用户同步清空
    } else {
      db.prepare('DELETE FROM users WHERE id < 0').run(); // 补录用户全量替换（删除动作也能同步）
    }
    for (const u of snap.manual_users || []) {
      usersSvc.upsertManualUser(u);
    }
    const settings = snap.settings || {};
    for (const k of OWNED_KEYS) {
      if (settings[k] !== undefined) state.setSetting(k, settings[k], { silent: true });
    }
    state.setSetting('cloud_last_beat', String(snap.beat_at || Date.now()), { silent: true });
    state.bumpVersion();
  })();
  res.json({ ok: true });
});

router.post('/api/sync/heartbeat', requirePair, (req, res) => {
  state.setSetting('cloud_last_beat', String(Date.now()), { silent: true });
  res.json({ ok: true });
});

module.exports = router;
