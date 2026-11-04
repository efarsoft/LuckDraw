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
const adminAuth = require('../lib/adminauth');
const { createRateLimiter } = require('../lib/ratelimit');

const router = express.Router();

// ---- 鉴权：账号密码会话（Cookie） ----
const loginLimit = createRateLimiter(15, 5 * 60_000); // 防爆破

function requireAdmin(req, res, next) {
  const user = adminAuth.sessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  req.adminUser = user;
  next();
}

/** 云端灾备开关：云端默认禁止开奖类写入（公网安全），管理台可一键启用接管 */
function requireCloudDrawEnabled(req, res, next) {
  if (config.ROLE === 'cloud' && state.getSetting('cloud_draw_enabled', '0') !== '1') {
    return res.status(403).json({ error: '云端备用开奖未启用：请在本页「活动设置」中开启「云端备用开奖」后接管' });
  }
  next();
}

/** v25 云端优先：配置（活动/奖品轮次）只在云端与单机可改，本地节点为执行端 */
function requireConfigMaster(req, res, next) {
  if (config.ROLE === 'local') {
    return res.status(403).json({ error: '配置已上收云端：请登录云端管理台（activity.域名/admin.html）修改活动与奖品' });
  }
  next();
}

/** 登录（下发 12 小时会话 Cookie） */
router.post('/api/admin/login', loginLimit, (req, res) => {
  const { username, password } = req.body || {};
  const admin = adminAuth.verifyLogin(username, password);
  if (!admin) return res.status(401).json({ error: '账号或密码错误' });
  adminAuth.issueSession(res, admin.username);
  res.json({ ok: true, username: admin.username });
});

router.post('/api/admin/logout', (req, res) => {
  adminAuth.clearSession(res);
  res.json({ ok: true });
});

router.get('/api/admin/me', (req, res) => {
  const user = adminAuth.sessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json({ username: user });
});

/** 修改自己的密码 */
router.post('/api/admin/password', requireAdmin, (req, res) => {
  try {
    adminAuth.changePassword(req.adminUser, (req.body || {}).newPassword);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

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
    phone: w.phone || '',
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
      profile_form_enabled: state.getSetting('profile_form_enabled', '1') === '1',
      group_reveal_threshold: parseInt(state.getSetting('group_reveal_threshold', '5'), 10) || 5,
      gift_note: state.getSetting('gift_note', ''),
      cloud_draw_enabled: state.getSetting('cloud_draw_enabled', '0') === '1',
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

router.put('/api/admin/activity', requireAdmin, requireConfigMaster, (req, res) => {
  const { title, subtitle, sign_in_enabled, profile_form_enabled, group_reveal_threshold, gift_note, cloud_draw_enabled } = req.body || {};
  if (cloud_draw_enabled !== undefined) state.setSetting('cloud_draw_enabled', cloud_draw_enabled ? '1' : '0');
  if (title !== undefined) state.setSetting('activity_title', String(title).slice(0, 60));
  if (subtitle !== undefined) state.setSetting('activity_subtitle', String(subtitle).slice(0, 80));
  if (gift_note !== undefined) state.setSetting('gift_note', String(gift_note).slice(0, 100));
  if (sign_in_enabled !== undefined) state.setSetting('sign_in_enabled', sign_in_enabled ? '1' : '0');
  if (profile_form_enabled !== undefined) state.setSetting('profile_form_enabled', profile_form_enabled ? '1' : '0');
  if (group_reveal_threshold !== undefined) {
    const n = parseInt(group_reveal_threshold, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 100) state.setSetting('group_reveal_threshold', String(n));
    else return res.status(400).json({ error: '集体揭晓阈值须为 1~100 的整数' });
  }
  sync.markDirty();
  res.json({ ok: true });
});

// ---- 轮次 ----
router.post('/api/admin/rounds', requireAdmin, requireConfigMaster, (req, res) => {
  res.json(draw.createRound(req.body || {}));
});

/** 奖品图片上传（base64 dataURL，落盘 data/uploads/prizes，返回 /uploads URL；上限 5MB） */
router.post('/api/admin/upload/prize', requireAdmin, requireConfigMaster, (req, res) => {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(String((req.body || {}).dataUrl || ''));
  if (!m) return res.status(400).json({ error: '仅支持 png/jpg/webp/gif 图片' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0) return res.status(400).json({ error: '图片内容为空' });
  if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: '图片不能超过 5MB' });
  const dir = path.join(config.DATA_DIR, 'uploads', 'prizes');
  fs.mkdirSync(dir, { recursive: true });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = `prize_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  res.json({ ok: true, url: `/uploads/prizes/${file}` });
});
router.put('/api/admin/rounds/:id', requireAdmin, requireConfigMaster, (req, res) => {
  res.json(draw.updateRound(parseInt(req.params.id, 10), req.body || {}));
});
router.delete('/api/admin/rounds/:id', requireAdmin, requireConfigMaster, (req, res) => {
  draw.deleteRound(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
router.post('/api/admin/rounds/:id/select', requireAdmin, requireCloudDrawEnabled, (req, res) => {
  draw.selectRound(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
router.post('/api/admin/phase', requireAdmin, requireCloudDrawEnabled, (req, res) => {
  draw.setPhase(String((req.body || {}).phase || ''));
  res.json({ ok: true });
});

/**
 * 开奖：本地节点先强制拉取云端迟到签到（best-effort，断网则用当前奖池），
 * 再执行事务化抽取 —— 幂等，连点/重试安全。
 */
router.post('/api/admin/rounds/:id/draw', requireAdmin, requireCloudDrawEnabled, async (req, res, next) => {
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
router.post('/api/admin/rounds/:id/redraw', requireAdmin, requireCloudDrawEnabled, async (req, res, next) => {
  try {
    const result = draw.drawRound(parseInt(req.params.id, 10), { redraw: true });
    res.json({ ok: true, winners: result.winners.map((w) => ({ ...w, avatar: w.avatar ? `/avatars/${w.avatar}` : null })) });
  } catch (e) {
    next(e);
  }
});

router.post('/api/admin/winners/:id/void', requireAdmin, requireCloudDrawEnabled, (req, res) => {
  draw.voidWinner(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

router.post('/api/admin/rounds/:id/rollback', requireAdmin, requireCloudDrawEnabled, (req, res) => {
  draw.rollbackRound(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ---- 用户管理（兜底名单） ----
router.post('/api/admin/users/manual', requireAdmin, requireCloudDrawEnabled, (req, res) => {
  const { name, note } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: '姓名不能为空' });
  const u = usersSvc.addManualUser(n.slice(0, 30), String(note || '').slice(0, 30) || null);
  sync.markDirty();
  res.json({ ok: true, user: { id: u.id, nickname: u.nickname } });
});

/** 批量导入：每行「姓名,手机尾号」或纯姓名 */
router.post('/api/admin/users/import', requireAdmin, requireCloudDrawEnabled, (req, res) => {
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

router.post('/api/admin/users/:id/block', requireAdmin, requireCloudDrawEnabled, (req, res) => {
  const blocked = !!((req.body || {}).blocked);
  const ok = usersSvc.setBlocked(parseInt(req.params.id, 10), blocked);
  if (!ok) return res.status(404).json({ error: '用户不存在' });
  sync.markDirty();
  res.json({ ok: true });
});

/** 参与者列表（管理台查看/排除用，倒序取最新） */
/** 操作员手动「立即同步」：强制拉取云端 + 有脏标立即推送 */
router.post('/api/admin/sync-now', requireAdmin, async (req, res) => {
  try {
    res.json(await sync.syncNow());
  } catch (e) {
    res.status(502).json({ error: `同步失败：${e.message || e}`, detail: sync.status() });
  }
});

router.get('/api/admin/users', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '400', 10) || 400, 1), 2000);
  const rows = db
    .prepare(
      `SELECT id, COALESCE(NULLIF(real_name,''), nickname) AS nickname, real_name, nickname AS wechat_nickname, avatar, source, note, phone, dept, in_pool, blocked, joined_at FROM users ORDER BY id ASC LIMIT ?`
    )
    .all(limit);
  res.json({ users: rows });
});

// ---- 工具 ----
router.get('/api/admin/qrcode', requireAdmin, async (req, res) => {
  const claim = req.query.claim === '1';
  const entry = req.query.entry === '1';
  const url = claim ? entryUrl() + '/claim' : entry ? entryUrl() + '/entry' : entryUrl();
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 480, margin: 2, color: { dark: '#5c0000', light: '#ffffff' } });
    res.json({ url, dataUrl });
  } catch {
    res.status(500).json({ error: '二维码生成失败' });
  }
});

router.get('/api/admin/export', requireAdmin, (req, res) => {
  const rounds = new Map(draw.listRounds().map((r) => [r.id, r]));
  const rows = [['轮次', '奖品', '姓名', '手机号', '企业/单位', '备注', '凭证码', '状态', '中奖时间']];
  for (const w of winnerRows()) {
    const r = rounds.get(w.round_id) || {};
    const u = usersSvc.getUser(w.user_id) || {};
    rows.push([
      r.name || `#${w.round_id}`,
      r.prize_name || '',
      w.nickname,
      u.phone || w.note || '',
      u.dept || '',
      u.phone ? '' : (w.note || ''),
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

/** 签到全量名单导出（活动后存档/对账） */
router.get('/api/admin/export/users', requireAdmin, (req, res) => {
  const rounds = new Map(draw.listRounds().map((r) => [r.id, r]));
  // 中奖情况：user_id → '轮次【奖品】'（含弃奖标记）
  const winInfo = new Map();
  for (const w of draw.listWinners()) {
    const r = rounds.get(w.round_id) || {};
    const label = `${r.name || ''}【${r.prize_name || ''}】`;
    winInfo.set(w.user_id, w.status === 'valid' ? label : `${label}（已弃奖）`);
  }
  const srcName = { wechat: '微信', mock: '模拟', manual: '补录', seed: '种子' };
  const users = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  const rows = [['序号', '姓名', '手机号', '企业/单位名称', '微信昵称', '来源', '是否入池', '中奖情况', '状态', '签到时间']];
  users.forEach((u, i) => {
    rows.push([
      i + 1,
      u.real_name || '',
      u.phone || u.note || '',
      u.dept || '',
      u.nickname || '',
      srcName[u.source] || u.source,
      u.in_pool ? '已入池' : '仅入场',
      winInfo.get(u.id) || '未中奖',
      u.blocked ? '已排除' : '正常',
      new Date(u.joined_at).toLocaleString('zh-CN', { hour12: false }),
    ]);
  });
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="users_${Date.now()}.csv"`);
  res.send(csv);
});

/** 彩排重置：winners=只清中奖；all=清全部数据 */
/** 重置只允许在本地/单机执行：云端重置会造成两端数据分裂（拉取无删除通道） */
router.post('/api/admin/reset', requireAdmin, (req, res) => {
  if (config.ROLE === 'cloud') {
    return res.status(403).json({ error: '重置操作请在本地节点执行（会同步清两端），云端单侧重置会造成数据分裂' });
  }
  const scope = String((req.body || {}).scope || '');
  if (scope === 'winners') {
    draw.resetWinners();
    return res.json({ ok: true });
  }
  if (scope === 'people') {
    // 清空人员与中奖，保留奖品轮次配置（彩排后常用：奖品不用重设，人员重新来）
    db.transaction(() => {
      db.prepare('DELETE FROM winners').run();
      db.prepare('DELETE FROM users').run();
      db.prepare(`UPDATE rounds SET status = 'pending', drawn_at = NULL`).run();
      state.setSetting('phase', 'idle', { silent: true });
      state.setSetting('current_round_id', '', { silent: true });
      state.bumpVersion();
    })();
    state.setSyncState('pull_watermark', '0');
    state.setSyncState('clear_users_flag', '1'); // 通知云端清空用户（不动云端轮次）
    sync.markDirty();
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
    state.setSyncState('pull_watermark', '0');
    state.setSyncState('clear_users_flag', '1');
    state.setSyncState('clear_config_flag', '1');
    sync.markDirty();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'scope 必须是 winners|people|all' });
});

module.exports = router;
