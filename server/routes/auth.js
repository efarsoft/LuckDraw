'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const wechat = require('../services/wechat');
const users = require('../services/users');
const state = require('../services/state');
const { setUserCookie, parseCookies, sign, verify } = require('../lib/cookiesign');
const { createRateLimiter } = require('../lib/ratelimit');

const router = express.Router();
const authLimit = createRateLimiter(30, 60_000);

/** 登录完成后的落点：
 *  entry 模式（入场签到）→ /entry（不进奖池）
 *  claim 模式（领奖查询）→ /claim
 *  默认（抽奖签到）→ 资料未完善进 /profile，否则参与页 / */
function postLoginRedirect(res, user, mode) {
  if (mode === 'entry') return res.redirect('/entry');
  if (mode === 'claim') return res.redirect('/claim');
  const required = state.getSetting('profile_form_enabled', '1') === '1';
  const need = required && !(user.real_name && user.phone);
  res.redirect(need ? '/profile' : '/');
}

/** 模式标记（entry/claim）：签名 Cookie 传递过 OAuth 回调（10 分钟） */
function setAuthMode(res, mode) {
  // 支持多个 Set-Cookie（先清旧值再设新值）
  const clears = ['entry', 'claim'].map(m => `ld_mode=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`).join('\r\n');
  if (mode) {
    res.setHeader('Set-Cookie', [
      `ld_mode=${sign(mode)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600`,
      `ld_mode_clear=1; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`
    ]);
  } else {
    res.setHeader('Set-Cookie', `ld_mode=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`);
  }
}
function readAuthMode(req) {
  const v = verify(parseCookies(req.headers.cookie).ld_mode || '');
  return (v === 'entry' || v === 'claim') ? v : null;
}

/** 入口：跳微信授权（始终重新识别身份，防同手机多账号串数据）。
 *  ?mode=entry = 入场签到（不进奖池）
 *  ?mode=claim = 领奖查询
 *  默认 = 抽奖签到（入池） */
router.get('/auth/wechat', authLimit, (req, res) => {
  const mode = req.query.mode === 'entry' ? 'entry' : req.query.mode === 'claim' ? 'claim' : null;
  if (wechat.isMock()) return res.redirect('/auth/mock' + (mode ? `?mode=${mode}` : ''));
  setAuthMode(res, mode);
  const stateVal = crypto.randomBytes(8).toString('hex');
  res.setHeader(
    'Set-Cookie',
    `ld_oauth_state=${sign(stateVal)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600`
  );
  res.redirect(wechat.authorizeUrl(`${config.BASE_URL}/auth/wechat/callback`, stateVal));
});

/** 微信授权回调：code 换用户 → 幂等入库 → 90 天签名 Cookie（扫码一次） */
router.get('/auth/wechat/callback', authLimit, async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const expectState = verify(cookies.ld_oauth_state || '');
    const gotState = String(req.query.state || '');
    if (!expectState || expectState !== gotState) {
      return res.status(400).send('授权状态校验失败，请重新扫码进入');
    }
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('授权失败：缺少 code');
    const info = await wechat.exchangeUser(code);
    if (!info || !info.openid) return res.status(502).send('微信授权失败，请稍后重试');
    const mode = readAuthMode(req);
    setAuthMode(res, null); // 用后即清
    const entry = mode === 'entry';
    const signInOpen = state.getSetting('sign_in_enabled', '1') === '1';
    const existing = db.prepare('SELECT * FROM users WHERE openid = ?').get(info.openid);
    if (!existing && !signInOpen) {
      return res.redirect('/?signin=closed'); // 通道已关且是新用户 → 拦截；老用户放行（Cookie 丢失场景）
    }
    // 关键修复：无论旧 Cookie 是谁，始终用本次 OAuth 识别到的 openid 为准
    const user = existing || (await users.signInUser({
      openid: info.openid,
      nickname: info.nickname,
      avatarUrl: info.avatarUrl,
      source: 'wechat',
      inPool: !entry, // 入场签到不进奖池；抽奖签到直接入池
    }));
    setUserCookie(res, user.id); // 覆盖旧 Cookie（可能是另一个微信号的）
    postLoginRedirect(res, user, mode || 'draw');
  } catch (e) {
    next(e);
  }
});

/** Mock 登录页（开发/彩排/演示）。?mode=entry = 入场签到 */
router.get('/auth/mock', authLimit, (req, res) => {
  if (state.getSetting('sign_in_enabled', '1') !== '1' && !hasValidUser(req)) {
    return res.redirect('/?signin=closed');
  }
  const entry = req.query.mode === 'entry';
  const q = entry ? '?mode=entry' : '';
  const qq = entry ? '?mode=entry&random=1' : '?random=1';
  res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>模拟登录</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:linear-gradient(160deg,#5c0000,#a30000);font-family:"Microsoft YaHei",sans-serif}
.card{background:rgba(255,255,255,.08);border:1px solid rgba(255,215,0,.35);border-radius:16px;
padding:36px 28px;width:min(90vw,360px);backdrop-filter:blur(6px)}
h2{color:#ffd700;margin:0 0 6px;text-align:center;font-size:22px}
p{color:rgba(255,255,255,.75);text-align:center;font-size:13px;margin:0 0 22px}
input{width:100%;box-sizing:border-box;padding:13px 14px;border-radius:10px;border:1px solid rgba(255,215,0,.4);
background:rgba(0,0,0,.25);color:#fff;font-size:16px;outline:none;margin-bottom:12px}
button{width:100%;padding:13px;border:none;border-radius:10px;font-size:16px;font-weight:bold;
cursor:pointer;background:linear-gradient(135deg,#ffd700,#ffb300);color:#7a0000}
button.ghost{background:transparent;color:#ffd700;border:1px solid rgba(255,215,0,.5);margin-top:10px}
</style></head><body><div class="card">
<h2>模拟登录（演示模式）</h2><p>${entry ? '入场签到：登记信息，不进入奖池' : '抽奖签到：授权后进入奖池'}</p>
<form method="POST" action="/auth/mock${q}">
<input name="name" placeholder="输入昵称（留空则随机）" maxlength="20">
<button type="submit">${entry ? '入场签到' : '签到进入奖池'}</button>
</form>
<form method="POST" action="/auth/mock${qq}"><button class="ghost" type="submit">用随机身份进入</button></form>
</div></body></html>`);
});

router.post('/auth/mock', authLimit, async (req, res, next) => {
  try {
    const signInOpen = state.getSetting('sign_in_enabled', '1') === '1';
    const entry = req.query.mode === 'entry';
    // 稳定 device id：同一浏览器重进保持同一身份（模拟"扫码一次"）
    let devId = parseCookies(req.headers.cookie).ld_dev;
    if (!devId || !/^[\w-]{6,64}$/.test(devId)) {
      devId = crypto.randomBytes(10).toString('hex');
      res.setHeader('Set-Cookie', `ld_dev=${devId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    }
    const openid = `mock_dev_${devId}`;
    const exist = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid); // 幂等
    if (exist) {
      setUserCookie(res, exist.id);
      return postLoginRedirect(res, exist, entry ? 'entry' : 'draw'); // 老用户：即使签到已关也放行（Cookie 丢失场景）
    }
    if (!signInOpen) return res.redirect('/?signin=closed'); // 新用户且通道已关 → 拦截
    const inputName = req.query.random ? '' : ((req.body && req.body.name) || '').trim();
    const user = await users.signInUser({
      openid,
      nickname: inputName || wechat.randomMockName(),
      avatarUrl: null,
      source: 'mock',
      inPool: !entry,
    });
    setUserCookie(res, user.id);
    postLoginRedirect(res, user, entry ? 'entry' : 'draw');
  } catch (e) {
    next(e);
  }
});

function hasValidUser(req) {
  return !!(req.user && req.user.id);
}

module.exports = router;
