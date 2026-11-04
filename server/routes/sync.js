'use strict';
const express = require('express');
const config = require('../config');
const db = require('../db');
const state = require('../services/state');
const usersSvc = require('../services/users');
const avatarLib = require('../lib/avatar');

/**
 * 云端侧同步端点（PAIR_KEY 鉴权）—— v25 云端优先架构：
 *  - GET  /api/sync/pull       本地节点增量拉取：用户（含变更）+ 奖品轮次 + 活动设置（配置回流）
 *  - GET  /api/sync/avatar     拉取已落盘的头像文件
 *  - POST /api/sync/push       接收本地执行结果：中奖/补录用户/运行态（当前轮+相位），幂等应用
 *  - POST /api/sync/heartbeat  心跳，供手机端展示数据新鲜度
 */
const router = express.Router();

function requirePair(req, res, next) {
  const key = req.headers['x-pair-key'] || '';
  if (!config.PAIR_KEY || key !== config.PAIR_KEY) return res.status(401).json({ error: 'pair key invalid' });
  next();
}

// 云端拥有、随拉取回流本地的设置键（本地推送不再携带这些，防覆盖）
const CLOUD_CONFIG_KEYS = ['activity_title', 'activity_subtitle', 'profile_form_enabled', 'sign_in_enabled', 'group_reveal_threshold', 'gift_note'];
// 本地执行端拥有、随推送上报的运行态键
const LOCAL_RUNTIME_KEYS = ['current_round_id', 'phase'];
// 全量重置时云端配置回落的默认值（与 db.js DEFAULT_SETTINGS 对齐）
const CONFIG_DEFAULTS = {
  activity_title: '年度盛典 · 幸运抽奖',
  activity_subtitle: '扫码参与 · 好运连连',
  profile_form_enabled: '1',
  sign_in_enabled: '1',
  group_reveal_threshold: '5',
  gift_note: '',
};

router.get('/api/sync/pull', requirePair, (req, res) => {
  const since = parseInt(req.query.since_id || '0', 10) || 0;
  const sinceTs = parseInt(req.query.since_ts || '0', 10) || 0;
  const users = db
    .prepare(
      `SELECT id, openid, nickname, avatar, source, note, real_name, phone, dept, in_pool, joined_at, updated_at FROM users
       WHERE id > 0 AND (id > ? OR updated_at > ?) ORDER BY id ASC LIMIT 500`
    )
    .all(since, sinceTs);
  const rounds = db.prepare('SELECT * FROM rounds ORDER BY id').all();
  // 中奖结果全量下发：本地采纳云端（灾备）开出的结果，保证两端奖池互斥、防重复中奖
  const winners = db.prepare('SELECT * FROM winners ORDER BY id').all();
  const settings = {};
  for (const k of CLOUD_CONFIG_KEYS) settings[k] = state.getSetting(k);
  res.json({ users, rounds, winners, settings, server_time: Date.now() });
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

router.post('/api/sync/push', requirePair, (req, res) => {
  const snap = req.body || {};
  if (!Array.isArray(snap.winners)) {
    return res.status(400).json({ error: '快照格式错误' });
  }
  db.transaction(() => {
    // 中奖结果全量替换（幂等，回滚/删除也能正确同步）
    db.prepare('DELETE FROM winners').run();
    const insWinner = db.prepare(`INSERT INTO winners(id, round_id, user_id, status, won_at) VALUES(?,?,?,?,?)`);
    for (const w of snap.winners) {
      insWinner.run(w.id, w.round_id, w.user_id, w.status, w.won_at);
    }
    // 由结果推导轮次状态（云端不重复执行开奖逻辑，以本地结果为准）
    db.prepare(`UPDATE rounds SET status = 'pending', drawn_at = NULL`).run();
    db.prepare(
      `UPDATE rounds SET status = 'drawn', drawn_at = (SELECT MAX(won_at) FROM winners w WHERE w.round_id = rounds.id)
       WHERE id IN (SELECT DISTINCT round_id FROM winners)`
    ).run();

    if (snap.clear_users) {
      db.prepare('DELETE FROM users').run(); // 本地全量重置 → 云端签到与补录用户同步清空
    } else {
      db.prepare('DELETE FROM users WHERE id < 0').run(); // 补录用户全量替换（删除动作也能同步）
    }
    for (const u of snap.manual_users || []) {
      usersSvc.upsertManualUser(u);
    }
    if (snap.clear_config) {
      // 本地全量重置：云端配置（轮次+活动设置）一并清空，回默认值
      db.prepare('DELETE FROM rounds').run();
      for (const k of CLOUD_CONFIG_KEYS) {
        state.setSetting(k, CONFIG_DEFAULTS[k] !== undefined ? CONFIG_DEFAULTS[k] : '', { silent: true });
      }
    }
    const settings = snap.settings || {};
    for (const k of LOCAL_RUNTIME_KEYS) {
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

/** 接收本地上传的头像文件（补录/种子用户的本地生成头像，云端磁盘没有 → 404 的根治） */
router.post('/api/sync/avatar', requirePair, (req, res) => {
  const { file, dataUrl } = req.body || {};
  if (!/^[\w.-]+\.(svg|png|jpe?g|webp)$/.test(String(file || ''))) {
    return res.status(400).json({ error: 'invalid file name' });
  }
  const m = /^data:image\/(svg\+xml|png|jpe?g|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return res.status(400).json({ error: 'invalid dataUrl' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'bad size' });
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(avatarLib.AVATAR_DIR, { recursive: true });
  fs.writeFileSync(path.join(avatarLib.AVATAR_DIR, file), buf);
  res.json({ ok: true });
});

module.exports = router;
