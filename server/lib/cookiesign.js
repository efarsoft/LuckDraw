'use strict';
const crypto = require('crypto');
const config = require('../config');

function hmac(value) {
  return crypto.createHmac('sha256', config.COOKIE_SECRET).update(String(value)).digest('base64url');
}

function sign(value) {
  return `${value}.${hmac(value)}`;
}

function verify(signed) {
  if (typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx <= 0) return null;
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expect = hmac(value);
  if (mac.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  return value;
}

/** 从 Cookie 头解析出对象 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

const COOKIE_NAME = 'ld_token';
const COOKIE_MAX_AGE = 90 * 24 * 3600; // 90 天：扫码一次，后续轮次免授权

function setUserCookie(res, userId) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(sign(userId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`
  );
}

function clearUserCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** 中间件：解析登录用户挂到 req.user（可能为 null） */
function cookieAuth(db) {
  const getUser = db.prepare('SELECT id, nickname, avatar, source, blocked FROM users WHERE id = ?');
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const uid = verify(cookies[COOKIE_NAME]);
    req.userId = uid ? parseInt(uid, 10) : null;
    req.user = null;
    if (req.userId != null) {
      const u = getUser.get(req.userId);
      if (u) req.user = u;
    }
    next();
  };
}

module.exports = { sign, verify, parseCookies, setUserCookie, clearUserCookie, cookieAuth, COOKIE_NAME };
