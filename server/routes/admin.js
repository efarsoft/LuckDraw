'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const draw = require('../services/draw');
const usersSvc = require('../services/users');
const state = require('../services/state');
const sync = require('../services/sync');
const QRCode = require('qrcode');
const { entryUrl } = require('./screen');
const { claimCode } = require('../lib/claimcode');

const router = express.Router();

// ---- 鉴权 ----
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key || '';
  if (!config.ADMIN_KEY || !timingSafeEqualStr(String(key), config.ADMIN_KEY)) {
    return res.status(401).json({ error: '管理密钥错误' });
  }
  next();
}
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function winnerRows() {
  return draw.listWinners().map((w) => ({
    id: w.id,
    round_id: w.round_id,
    user_id: w.user_id,
    status: w.status,
    won_at: w.won_at,
    claim_code: claimCode(w.id),
    nickname: w.nickname || `用户#${w.user_id}`,
    note: w.note || '',
    avatar: w.avatar ? `/avatars/${w.avatar}` : null,
  }));
}

router.get('/api/admin/overview', requireAdmin, (req, res) => {
  const rounds = draw.listRounds();
  const currentRoundId = parseInt(state.getSetting('current_round_id', '0'), 10) || null;
  res.json({
    v: state.getVersion(),
    role: config.ROLE,
    activity: {
      title: state.getSetting('activity_title'),
      subtitle: state.getSetting('activity_subtitle'),
      sign_in_enabled: state.getSetting('sign_in_enabled', '1') === '1',
    },
    phase: state.getSetting('phase', 'idle'),
    current_round_id: currentRoundId,
    rounds,
    winners: winnerRows(),
    stats: {
      users: usersSvc.countUsers(),
      pool: draw.poolCount(),
      won: db.prepare(`SELECT COUNT(*) AS c FROM winners`).get().c,
    },
    sync: sync.status(),
    entry_url: entryUrl(),
  });
});

router.put('/api/admin/activity', requireAdmin, (req, res) => {
  const { title, subtitle, sign_in_enabled } = req.body || {};
  if (title !== undefined) state.setSetting('activity_title', String(title).slice(0, 60));
  if (subtitle !== undefined) state.setSetting('activity_subtitle', String(subtitle).slice(0, 80));
  if (sign_in_enabled !== undefined) state.setSetting('sign_in_enabled', sign_in_enabled ? '1' : '0');
  sync.markDirty();
  res.json({ ok: true });
});

// ---- 轮次 ----
router.post('/api/admin/rounds', requireAdmin, (req, res) => {
  res.json(draw.createRound(req.body || {}));
});

/** 奖品图片上传（base64 dataURL，落盘 data/uploads/prizes，返回 /uploads URL） */
router.post('/api/admin/upload/prize', requireAdmin, (req, res) => {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(String((req.body || {}).dataUrl || ''));
  if (!m) return res.status(400).json({ error: '仅支持 png/jpg/webp/gif 图片' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return res.status(400).json({ error: '图片内容为空' });
  if (buf.length > 1.5 * 1024 * 1024) return res.status(400).json({ error: '图片不能超过 1.5MB' });
  const dir = path.join(config.DATA_DIR, 'uploads', 'prizes');
  fs.mkdirSync(dir, { recursive: true });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = `prize_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  res.json({ ok: true, url: `/uploads/prizes/${file}` });
});
router.put('/api/admin/rounds/:id', requireAdmin, (req, res) => {
  res.json(draw.updateRound(parseInt(req.params.id, 10), req.body || {}));
});
router.delete('/api/admin/rounds/:id', requireAdmin, (req, res) => {
  draw.deleteRound(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
router.post('/api/admin/rounds/:id/select', requireAdmin, (req, res) => {
  draw.selectRound(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
router.post('/api/admin/phase', requireAdmin, (req, res) => {
  draw.setPhase(String((req.body || {}).phase || ''));
  res.json({ ok: true });
});

/**
 * 开奖：本地节点先强制拉取云端迟到签到（best-effort，断网则用当前奖池），
 * 再执行事务化抽取 —— 幂等，连点/重试安全。
 */
router.post('/api/admin/rounds/:id/draw', requireAdmin, async (req, res, next) => {
  try {
    if (config.ROLE === 'local') await sync.forcePull();
    const result = draw.drawRound(parseInt(req.params.id, 10));
    res.json({
      ok: true,
      round: result.round || draw.getRound(parseInt(req.params.id, 10)),
      winners: (result.winners || result).map
        ? (result.winners || result).map((w) => ({ ...w, avatar: w.avatar ? `/avatars/${w.avatar}` : null }))
        : [],
      pool_exhausted: result.poolExhausted || false,
    });
  } catch (e) {
    next(e);
  }
});

/** 补抽：弃奖后补齐本轮有效名额 */
router.post('/api/admin/rounds/:id/redraw', requireAdmin, async (req, res, next) => {
  try {
    const result = draw.drawRound(parseInt(req.params.id, 10), { redraw: true });
    res.json({ ok: true, winners: result.winners.map((w) => ({ ...w, avatar: w.avatar ? `/avatars/${w.avatar}` : null })) });
  } catch (e) {
    next(e);
  }
});

router.post('/api/admin/winners/:id/void', requireAdmin, (req, res) => {
  draw.voidWinner(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/api/admin/rounds/:id/rollback', requireAdmin, (req, res) => {
  draw.rollbackRound(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ---- 用户管理（兜底名单） ----
router.post('/api/admin/users/manual', requireAdmin, (req, res) => {
  const { name, note } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: '姓名不能为空' });
  const u = usersSvc.addManualUser(n.slice(0, 30), String(note || '').slice(0, 30) || null);
  sync.markDirty();
  res.json({ ok: true, user: { id: u.id, nickname: u.nickname } });
});

/** 批量导入：每行「姓名,手机尾号」或纯姓名 */
router.post('/api/admin/users/import', requireAdmin, (req, res) => {
  const text = String((req.body || {}).text || '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: '名单为空' });
  let added = 0;
  const errors = [];
  for (const line of lines.slice(0, 2000)) {
    const parts = line.split(/[,，\t]/).map((s) => s.trim());
    const name = parts[0];
    const note = parts[1] || '';
    if (!name) continue;
    try {
      usersSvc.addManualUser(name, note || null);
      added++;
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  sync.markDirty();
  res.json({ ok: true, added, errors });
});

router.post('/api/admin/users/:id/block', requireAdmin, (req, res) => {
  const blocked = !!((req.body || {}).blocked);
  const ok = usersSvc.setBlocked(parseInt(req.params.id, 10), blocked);
  if (!ok) return res.status(404).json({ error: '用户不存在' });
  sync.markDirty();
  res.json({ ok: true });
});

/** 参与者列表（管理台查看/排除用，倒序取最新） */
router.get('/api/admin/users', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '400', 10) || 400, 1), 2000);
  const rows = db
    .prepare(
      `SELECT id, nickname, avatar, source, note, blocked, joined_at FROM users ORDER BY id ASC LIMIT ?`
    )
    .all(limit);
  res.json({ users: rows });
});

// ---- 工具 ----
router.get('/api/admin/qrcode', requireAdmin, async (req, res) => {
  const claim = req.query.claim === '1';
  const url = claim ? entryUrl() + '/?claim=1' : entryUrl();
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 2, color: { dark: '#5c0000', light: '#ffffff' } });
    res.json({ url, dataUrl });
  } catch {
    res.status(500).json({ error: '二维码生成失败' });
  }
});

router.get('/api/admin/export', requireAdmin, (req, res) => {
  const rounds = new Map(draw.listRounds().map((r) => [r.id, r]));
  const rows = [['轮次', '奖品', '姓名', '手机尾号/备注', '凭证码', '状态', '中奖时间']];
  for (const w of winnerRows()) {
    const r = rounds.get(w.round_id) || {};
    rows.push([
      r.name || `#${w.round_id}`,
      r.prize_name || '',
      w.nickname,
      w.note || '',
      w.claim_code,
      w.status === 'valid' ? '有效' : '弃奖',
      new Date(w.won_at).toLocaleString('zh-CN', { hour12: false }),
    ]);
  }
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="winners_${Date.now()}.csv"`);
  res.send(csv);
});

/** 彩排重置：winners=只清中奖；all=清全部数据 */
router.post('/api/admin/reset', requireAdmin, (req, res) => {
  const scope = String((req.body || {}).scope || '');
  if (scope === 'winners') {
    draw.resetWinners();
    return res.json({ ok: true });
  }
  if (scope === 'all') {
    db.transaction(() => {
      db.prepare('DELETE FROM winners').run();
      db.prepare('DELETE FROM rounds').run();
      db.prepare('DELETE FROM users').run();
      state.setSetting('phase', 'idle', { silent: true });
      state.setSetting('current_round_id', '', { silent: true });
      state.bumpVersion();
    })();
    state.setSyncState('pull_watermark', '0'); // 清空拉取水位，避免云端残留用户回流复活
    state.setSyncState('clear_users_flag', '1'); // 随下一次快照通知云端清空签到用户
    sync.markDirty();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'scope 必须是 winners|all' });
});

module.exports = router;
