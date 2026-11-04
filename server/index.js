'use strict';
const express = require('express');
const path = require('path');
const config = require('./config');
const db = require('./db');
const state = require('./services/state');
const sync = require('./services/sync');
const usersSvc = require('./services/users');
const wechat = require('./services/wechat');
const { cookieAuth } = require('./lib/cookiesign');
const { createRateLimiter } = require('./lib/ratelimit');

const app = express();
app.disable('x-powered-by');
// 奖品图上传通道：独立大限额解析器（5MB 图片 base64 后约 6.7MB），须挂在全局小限额之前
app.post('/api/admin/upload/prize', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(cookieAuth(db));

// 静态资源（本地化，无任何 CDN 依赖）
app.use('/avatars', express.static(path.join(config.DATA_DIR, 'avatars'), { maxAge: '7d', immutable: true }));
app.use('/uploads', express.static(path.join(config.DATA_DIR, 'uploads'), { maxAge: '7d', immutable: true }));
app.use(
  express.static(config.PUBLIC_DIR, {
    etag: true,
    maxAge: '1h',
    setHeaders(res, p) {
      // HTML 与 SW 必须每次回源校验（304 也便宜），否则改版后旧页面最长滞留 1 小时
      if (p.endsWith('.html') || p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// ---- 按角色装配路由 ----
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const screenRoutes = require('./routes/screen');
const adminRoutes = require('./routes/admin');
const syncRoutes = require('./routes/sync');

if (config.ROLE === 'cloud' || config.ROLE === 'standalone') {
  app.use(authRoutes); // 微信授权 / Mock 登录（用户入口）
  app.use(apiRoutes);  // 用户页轮询
}
// 大屏 + 管理台：本地/单机为主；云端也挂载（灾备模式——开奖写入由 cloud_draw_enabled 开关把守）
app.use(screenRoutes.router);
app.use(adminRoutes);
if (config.ROLE === 'cloud' || config.ROLE === 'standalone') {
  app.use(syncRoutes);          // 云端同步端点（standalone 下无害闲置）
}

// 本地节点：用户误访问 / 时引导去云端签到
if (config.ROLE === 'local') {
  app.get(['/', '/index.html'], (req, res) => res.redirect(config.CLOUD_PUBLIC_URL || '/screen.html'));
}

// ---- 开发/演示工具：批量假用户（Mock 模式或管理员会话） ----
// 注意：local 节点用负数 id 造演示用户，避免与云端拉回的真实用户 id 冲突
const seedLimit = createRateLimiter(10, 60_000);
app.get('/dev/seed', seedLimit, async (req, res, next) => {
  if (!config.USE_MOCK) {
    const admin = require('./lib/adminauth').sessionUser(req);
    if (!admin) return res.status(401).json({ error: '需要管理员登录' });
  }
  try {
    const n = Math.min(Math.max(parseInt(req.query.n || '20', 10) || 20, 1), 500);
    for (let i = 0; i < n; i++) {
      const name = wechat.randomMockName();
      if (config.ROLE === 'local') {
        usersSvc.addManualUser(name, '演示'); // 负数 id，不与云端冲突
      } else {
        await usersSvc.signInUser({
          openid: `seed_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          nickname: name,
          avatarUrl: null,
          source: 'seed',
        });
      }
    }
    res.json({ ok: true, seeded: n, total: usersSvc.countUsers() });
  } catch (e) {
    next(e);
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, role: config.ROLE, time: Date.now() }));

// ---- 统一错误处理 ----
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(`[${new Date().toISOString()}]`, err);
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

// ---- 启动 ----
if (config.ROLE === 'local') sync.start();

app.listen(config.PORT, () => {
  console.log('========================================');
  console.log(`  幸运抽奖系统已启动`);
  console.log(`  角色: ${config.ROLE}`);
  console.log(`  地址: http://localhost:${config.PORT}`);
  if (config.ROLE === 'standalone') console.log(`  用户页: /    大屏: /screen.html    管理台: /admin.html`);
  if (config.ROLE === 'cloud') console.log(`  用户签到入口: ${config.BASE_URL}/auth/wechat`);
  if (config.ROLE === 'local') {
    console.log(`  大屏: /screen.html    管理台: /admin.html`);
    console.log(`  云端: ${config.CLOUD_URL}（断网自动重连，结果离线续传）`);
  }
  console.log(`  微信模式: ${wechat.isMock() ? 'Mock 演示' : '真实 OAuth'}`);
  console.log('========================================');
});
