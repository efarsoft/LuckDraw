'use strict';
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

/** 管理台账号密码登录：scrypt 加盐哈希 + HMAC 签名会话 Cookie（12 小时） */

const SESSION_MS = 12 * 3600 * 1000;
const COOKIE_NAME = 'ld_admin';

function hmac(payload) {
  return crypto.createHmac('sha256', config.COOKIE_SECRET).update(payload).digest('base64url');
}

/** 校验账号密码；成功返回管理员行并刷新最后登录时间 */
function verifyLogin(username, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
  if (!admin) return null;
  const hash = crypto.scryptSync(String(password || ''), admin.pass_salt, 64).toString('hex');
  const a = Buffer.from(hash), b = Buffer.from(admin.pass_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  db.prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(Date.now(), admin.id);
  return admin;
}

/** 下发会话 Cookie */
function issueSession(res, username) {
  const payload = `${username}.${Date.now() + SESSION_MS}`;
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(payload + '.' + hmac(payload))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`
  );
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** 从请求解析会话；有效返回用户名，否则 null */
function sessionUser(req) {
  const cookies = require('./cookiesign').parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = raw.slice(0, idx);
  const mac = raw.slice(idx + 1);
  const expect = hmac(payload);
  if (mac.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  const [username, exp] = payload.split('.');
  if (!username || !exp || Date.now() > parseInt(exp, 10)) return null;
  return username;
}

/** 修改密码（当前会话持有者） */
function changePassword(username, newPassword) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin) return false;
  const pass = String(newPassword || '');
  if (pass.length < 6) throw Object.assign(new Error('新密码至少 6 位'), { status: 400 });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admins SET pass_salt = ?, pass_hash = ? WHERE id = ?').run(
    salt, crypto.scryptSync(pass, salt, 64).toString('hex'), admin.id
  );
  return true;
}

module.exports = { verifyLogin, issueSession, clearSession, sessionUser, changePassword };
