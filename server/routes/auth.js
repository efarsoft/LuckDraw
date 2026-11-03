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

/** 入口：跳微信授权（Mock 模式跳模拟登录页） */
router.get('/auth/wechat', authLimit, (req, res) => {
  if (state.getSetting('sign_in_enabled', '1') !== '1' && !hasValidUser(req)) {
    return res.redirect('/?signin=closed');
  }
  if (wechat.isMock()) return res.redirect('/auth/mock');
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
    const user = await users.signInUser({
      openid: info.openid,
      nickname: info.nickname,
      avatarUrl: info.avatarUrl,
      source: 'wechat',
    });
    setUserCookie(res, user.id);
    res.redirect('/');
  } catch (e) {
    next(e);
  }
});

/** Mock 登录页（开发/彩排/演示） */
router.get('/auth/mock', authLimit, (req, res) => {
  if (state.getSetting('sign_in_enabled', '1') !== '1' && !hasValidUser(req)) {
    return res.redirect('/?signin=closed');
  }
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
<h2>模拟登录（演示模式）</h2><p>未配置微信服务号，使用模拟身份签到</p>
<form method="POST" action="/auth/mock">
<input name="name" placeholder="输入昵称（留空则随机）" maxlength="20">
<button type="submit">签到进入奖池</button>
</form>
<form method="POST" action="/auth/mock?random=1"><button class="ghost" type="submit">用随机身份进入</button></form>
</div></body></html>`);
});

router.post('/auth/mock', authLimit, async (req, res, next) => {
  try {
    if (state.getSetting('sign_in_enabled', '1') !== '1' && !hasValidUser(req)) {
      return res.redirect('/?signin=closed');
    }
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
      return res.redirect('/');
    }
    const inputName = req.query.random ? '' : ((req.body && req.body.name) || '').trim();
    const user = await users.signInUser({
      openid,
      nickname: inputName || wechat.randomMockName(),
      avatarUrl: null,
      source: 'mock',
    });
    setUserCookie(res, user.id);
    res.redirect('/');
  } catch (e) {
    next(e);
  }
});

function hasValidUser(req) {
  return !!(req.user && req.user.id);
}

module.exports = router;
