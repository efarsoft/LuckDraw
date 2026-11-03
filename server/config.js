'use strict';
const path = require('path');

function loadEnvFile() {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (m[1] === 'ROLE' && process.env.LD_ROLE_OVERRIDE) continue; // 测试时命令行覆盖
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnvFile();

const ROLE = (process.env.ROLE || 'standalone').toLowerCase();
if (!['standalone', 'cloud', 'local'].includes(ROLE)) {
  throw new Error(`ROLE 必须是 standalone|cloud|local，当前: ${ROLE}`);
}

const config = {
  ROLE,
  PORT: parseInt(process.env.PORT || '3000', 10),
  BASE_URL: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  CLOUD_URL: (process.env.CLOUD_URL || '').replace(/\/+$/, ''),
  CLOUD_PUBLIC_URL: (process.env.CLOUD_PUBLIC_URL || '').replace(/\/+$/, ''),
  ENTRY_URL: (process.env.ENTRY_URL || '').replace(/\/+$/, ''),   // 二维码强制指向（预览/彩排时指云端真地址）
  PAIR_KEY: process.env.PAIR_KEY || '',
  ADMIN_KEY: process.env.ADMIN_KEY || '',
  COOKIE_SECRET: process.env.COOKIE_SECRET || 'dev-secret-do-not-use-in-prod-0123456789',
  USE_MOCK: (process.env.USE_MOCK || '1') === '1',
  WECHAT_APP_ID: process.env.WECHAT_APP_ID || '',
  WECHAT_APP_SECRET: process.env.WECHAT_APP_SECRET || '',
  SYNC_PULL_INTERVAL_MS: parseInt(process.env.SYNC_PULL_INTERVAL_MS || '3000', 10),
  SYNC_PUSH_INTERVAL_MS: parseInt(process.env.SYNC_PUSH_INTERVAL_MS || '5000', 10),
  ROOT_DIR: path.join(__dirname, '..'),
  DATA_DIR: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
};

if (config.ROLE === 'local' && !config.CLOUD_URL) {
  throw new Error('ROLE=local 必须配置 CLOUD_URL（云端节点地址）');
}
if (config.ROLE === 'local' && !config.CLOUD_PUBLIC_URL) config.CLOUD_PUBLIC_URL = config.CLOUD_URL;
if (!config.PAIR_KEY && config.ROLE !== 'standalone') {
  throw new Error('双节点部署必须配置 PAIR_KEY');
}

module.exports = config;
