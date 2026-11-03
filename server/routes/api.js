'use strict';
const express = require('express');
const db = require('../db');
const state = require('../services/state');
const usersSvc = require('../services/users');
const { createRateLimiter } = require('../lib/ratelimit');

const router = express.Router();
const pollLimit = createRateLimiter(240, 60_000); // 长轮询挂起不计数也够用，此处防滥用

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录', need_auth: true });
  next();
}

/** 领奖凭证码：由 winner id + 密钥派生的稳定短码，供领奖台人工核对 */
const { claimCode } = require('../lib/claimcode');

function buildMeState(userId) {
  const me = db
    .prepare('SELECT nickname, real_name, phone, dept, avatar FROM users WHERE id = ?')
    .get(userId) || {};
  const activity = {
    title: state.getSetting('activity_title'),
    subtitle: state.getSetting('activity_subtitle'),
  };
  const rounds = db
    .prepare('SELECT id, seq, name, prize_name, prize_image, winner_count, status, drawn_at FROM rounds ORDER BY seq ASC, id ASC')
    .all();
  const myWin = db
    .prepare(
      `SELECT w.id AS winner_id, w.status AS win_status, r.name AS round_name, r.prize_name, r.seq, w.won_at
       FROM winners w JOIN rounds r ON r.id = w.round_id
       WHERE w.user_id = ? AND w.status = 'valid' LIMIT 1`
    )
    .get(userId);
  const lastBeat = parseInt(state.getSetting('cloud_last_beat', '0'), 10) || 0;
  const stale = lastBeat > 0 && Date.now() - lastBeat > 15_000; // 现场链路波动提示
  const profileRequired = state.getSetting('profile_form_enabled', '1') === '1';
  const displayName = me.real_name || me.nickname;
  return {
    v: state.getVersion(),
    activity,
    phase: state.getSetting('phase', 'idle'),
    current_round_id: parseInt(state.getSetting('current_round_id', '0'), 10) || null,
    me: {
      nickname: displayName,
      wechat_nickname: me.nickname,
      phone: me.phone || null,
      dept: me.dept || null,
      avatar: me.avatar ? `/avatars/${me.avatar}` : null,
    },
    profile_required: profileRequired,
    profile_complete: !!(me.real_name && me.phone),
    rounds: rounds.map((r) => ({ ...r, drawn: r.status === 'drawn' })),
    my_win: myWin
      ? {
          round_name: myWin.round_name,
          prize_name: myWin.prize_name,
          seq: myWin.seq,
          won_at: myWin.won_at,
          claim_code: claimCode(myWin.winner_id),
        }
      : null,
    link: { last_beat: lastBeat || null, stale },
    server_time: Date.now(),
  };
}

/** 用户页长轮询：带 v 且无变化时挂起至版本变化或超时（204 = 无变化） */
router.get('/api/me/state', pollLimit, requireUser, async (req, res) => {
  const clientV = parseInt(req.query.v || '0', 10) || 0;
  const waitMs = Math.min(parseInt(req.query.wait || '20000', 10) || 20000, 25000);
  const currentV = state.getVersion();
  if (clientV && clientV >= currentV) {
    let closed = false;
    req.on('close', () => (closed = true));
    const changed = await state.waitForChange(currentV, waitMs);
    if (closed) return;
    if (!changed) return res.status(204).end();
  }
  res.json(buildMeState(req.user.id));
});

/** 资料填写（签到第二页）：姓名 + 手机号必填，企业/单位名称选填 */
router.post('/api/me/profile', pollLimit, requireUser, (req, res, next) => {
  try {
    const u = usersSvc.setProfile(req.user.id, req.body || {});
    res.json({ ok: true, profile_complete: usersSvc.profileComplete(u) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
