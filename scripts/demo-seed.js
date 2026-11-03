'use strict';
/**
 * 演示数据种子：批量生成模拟用户 + 三个示例轮次（不开奖，留给现场流程体验）
 * 用法：node scripts/demo-seed.js [用户数，默认60] [服务地址，默认 http://localhost:3000]
 * 登录：读 .env 的 ADMIN_USER/ADMIN_PASSWORD（默认 admin/admin888）换取会话 Cookie。
 */
const fs = require('fs');
const path = require('path');
const [,, nArg = '60', baseArg = process.env.BASE_URL || 'http://localhost:3000'] = process.argv;
const N = Math.min(Math.max(parseInt(nArg, 10) || 60, 1), 500);
const BASE = baseArg.replace(/\/+$/, '');

function readEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const env = readEnv();
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USER || env.ADMIN_USER || 'admin',
      password: process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD || 'admin888',
    }),
  });
  if (!login.ok) { console.error('✗ 管理员登录失败：', await login.text()); process.exit(1); }
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const auth = { cookie, 'content-type': 'application/json' };
  console.log('✓ 管理员登录成功');

  const seed = await fetch(`${BASE}/dev/seed?n=${N}`).then((r) => r.json());
  console.log(`✓ 模拟用户：已生成 ${seed.seeded} 人（总计 ${seed.total}）`);

  const rounds = [
    { name: '第一轮 · 开门红', prize_name: '智能音箱', winner_count: 5 },
    { name: '第二轮 · 好运来', prize_name: '扫地机器人', winner_count: 3 },
    { name: '压轴大奖', prize_name: 'iPhone 17 Pro', winner_count: 1 },
  ];
  for (const r of rounds) {
    const resp = await fetch(`${BASE}/api/admin/rounds`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(r),
    }).then((x) => x.json());
    if (resp.error) { console.error(`✗ 轮次创建失败: ${resp.error}`); process.exit(1); }
    console.log(`✓ 轮次：${resp.name}（${resp.prize_name} × ${resp.winner_count}）`);
  }
  console.log('\n演示就绪：打开管理台 → 选中轮次 → 开始滚动 → 立即揭晓');
}
main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
