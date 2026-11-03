'use strict';
const express = require('express');
const db = require('../db');
const state = require('../services/state');
const config = require('../config');
const QRCode = require('qrcode');

const router = express.Router();

/** 大屏用头像墙采样（每轮随机抽样，上限控制载荷；展示名优先真实姓名） */
function poolSample(limit = 120) {
  const c = db
    .prepare(
      `SELECT COUNT(*) AS c FROM users WHERE blocked = 0 AND id NOT IN (SELECT user_id FROM winners)`
    )
    .get().c;
  const rows = db
    .prepare(
      `SELECT u.id, COALESCE(NULLIF(u.real_name,''), u.nickname) AS nickname, u.avatar FROM users u
       WHERE u.blocked = 0 AND u.id NOT IN (SELECT user_id FROM winners)
       ORDER BY RANDOM() LIMIT ?`
    )
    .all(limit);
  return { count: c, sample: rows.map((u) => ({ id: u.id, nickname: u.nickname, avatar: u.avatar })) };
}

function buildScreenState() {
  const rounds = db
    .prepare('SELECT id, seq, name, prize_name, prize_image, winner_count, status, drawn_at FROM rounds ORDER BY seq ASC, id ASC')
    .all();
  const winnersByRound = {};
  for (const r of rounds) {
    winnersByRound[r.id] = db
      .prepare(
        `SELECT w.user_id, w.status, u.nickname, u.avatar FROM winners w
         LEFT JOIN users u ON u.id = w.user_id WHERE w.round_id = ? ORDER BY w.id`
      )
      .all(r.id)
      .map((w) => ({ ...w, avatar: w.avatar ? `/avatars/${w.avatar}` : null }));
  }
  const currentRoundId = parseInt(state.getSetting('current_round_id', '0'), 10) || null;
  const pool = poolSample();
  return {
    v: state.getVersion(),
    activity: {
      title: state.getSetting('activity_title'),
      subtitle: state.getSetting('activity_subtitle'),
    },
    group_reveal_threshold: parseInt(state.getSetting('group_reveal_threshold', '5'), 10) || 5,
    phase: state.getSetting('phase', 'idle'),
    current_round_id: currentRoundId,
    rounds: rounds.map((r) => ({ ...r, drawn: r.status === 'drawn' })),
    winners_by_round: winnersByRound,
    pool_count: pool.count,
    pool_sample: pool.sample.map((u) => ({ ...u, avatar: u.avatar ? `/avatars/${u.avatar}` : null })),
    sign_count: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    server_time: Date.now(),
  };
}

router.get('/api/screen/state', async (req, res) => {
  const clientV = parseInt(req.query.v || '0', 10) || 0;
  const waitMs = Math.min(parseInt(req.query.wait || '25000', 10) || 25000, 25000);
  const currentV = state.getVersion();
  if (clientV && clientV >= currentV) {
    let closed = false;
    req.on('close', () => (closed = true));
    const changed = await state.waitForChange(currentV, waitMs);
    if (closed) return;
    if (!changed) return res.status(204).end();
  }
  res.json(buildScreenState());
});

/** 大屏签到二维码（公开：入口地址本身就是公开信息） */
router.get('/api/screen/qr', async (req, res) => {
  const entry = entryUrl();
  try {
    const dataUrl = await QRCode.toDataURL(entry, { width: 480, margin: 2, color: { dark: '#5c0000', light: '#ffffff' } });
    res.json({ url: entry, dataUrl });
  } catch (e) {
    res.status(500).json({ error: '二维码生成失败' });
  }
});

function entryUrl() {
  return config.ROLE === 'local' ? config.CLOUD_PUBLIC_URL : config.BASE_URL;
}

module.exports = { router, buildScreenState, entryUrl };
