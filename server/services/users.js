'use strict';
const db = require('../db');
const avatarLib = require('../lib/avatar');
const state = require('./state');

/**
 * 签到/注册用户（云端签到、Mock 登录、种子共用的幂等入口）。
 * openid 唯一约束：重复扫码/断网重试不会产生重复用户。
 * 远程头像优先下载落盘（云端有外网），失败落回首字母 SVG。
 */
async function signInUser({ openid, nickname, avatarUrl = null, source = 'wechat', note = null }) {
  const existing = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
  if (existing) return existing; // 已在奖池：幂等返回，不更新（保持现场名单稳定）

  let avatarFile = null;
  if (avatarUrl) avatarFile = await avatarLib.downloadAvatar(avatarUrl, openid.slice(-12));
  if (!avatarFile) avatarFile = avatarLib.generateInitialAvatar(nickname);

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO users(openid, nickname, avatar, source, note, blocked, joined_at, updated_at)
       VALUES(?,?,?,?,?,0,?,?)`
    )
    .run(openid, String(nickname || '神秘用户').slice(0, 30), avatarFile, source, note, now, now);
  state.bumpVersion();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

/** 扫码资料填写：姓名+手机号必填，部门选填；完成后视为完成签到 */
function setProfile(userId, { real_name, phone, dept }) {
  const name = String(real_name || '').trim().slice(0, 20);
  const mobile = String(phone || '').trim();
  const department = String(dept || '').trim().slice(0, 30) || null;
  if (!name) throw Object.assign(new Error('请填写姓名'), { status: 400 });
  if (!/^1[3-9]\d{9}$/.test(mobile)) throw Object.assign(new Error('手机号格式不正确'), { status: 400 });
  const r = db
    .prepare('UPDATE users SET real_name = ?, phone = ?, dept = ?, updated_at = ? WHERE id = ?')
    .run(name, mobile, department, Date.now(), userId);
  if (r.changes === 0) throw Object.assign(new Error('用户不存在'), { status: 404 });
  state.bumpVersion();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

/** 资料是否已完善（配合 profile_form_enabled 决定是否强制填写） */
function profileComplete(user) {
  return !!(user && user.real_name && user.phone);
}

/** 本地节点：应用云端拉取回来的用户（显式使用云端 id，保证 winners 引用一致） */
function upsertPulledUser(u) {
  const existing = db.prepare('SELECT id, blocked FROM users WHERE id = ?').get(u.id);
  if (existing) return false; // 增量水位保证基本不会走到；走到则保留本地 blocked 标记
  db.prepare(
    `INSERT INTO users(id, openid, nickname, avatar, source, note, real_name, phone, dept, blocked, joined_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,0,?,?)`
  ).run(u.id, u.openid, u.nickname, u.avatar, u.source || 'wechat', u.note || null, u.real_name || null, u.phone || null, u.dept || null, u.joined_at, u.joined_at);
  return true;
}

/** 云端节点：应用本地推送的手动用户（负数 id，与云端自增 id 空间不冲突） */
function upsertManualUser(u) {
  db.prepare(
    `INSERT INTO users(id, openid, nickname, avatar, source, note, blocked, joined_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname, avatar=excluded.avatar, note=excluded.note, blocked=excluded.blocked`
  ).run(u.id, u.openid, u.nickname, u.avatar, u.source, u.note, u.blocked ? 1 : 0, u.joined_at, u.joined_at);
}

/** 手动添加（本地兜底：手机无信号的用户），使用负数 id 防与云端 id 冲突 */
function addManualUser(nickname, note = null) {
  const row = db.prepare('SELECT MIN(id) AS m FROM users WHERE id < 0').get();
  const id = Math.min(-1, (row.m || 0) - 1);
  const avatarFile = avatarLib.generateInitialAvatar(nickname);
  const now = Date.now();
  db.prepare(
    `INSERT INTO users(id, openid, nickname, avatar, source, note, blocked, joined_at, updated_at)
     VALUES(?,?,?,?,'manual',?,0,?,?)`
  ).run(id, `manual_${-id}`, nickname, avatarFile, note, now, now);
  state.bumpVersion();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function setBlocked(userId, blocked) {
  const r = db.prepare('UPDATE users SET blocked = ?, updated_at = ? WHERE id = ?').run(blocked ? 1 : 0, Date.now(), userId);
  if (r.changes > 0) state.bumpVersion();
  return r.changes > 0;
}

const listUsers = () => db.prepare('SELECT * FROM users ORDER BY joined_at ASC').all();
const countUsers = () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

module.exports = { signInUser, upsertPulledUser, upsertManualUser, addManualUser, setBlocked, setProfile, profileComplete, listUsers, countUsers, getUser };
