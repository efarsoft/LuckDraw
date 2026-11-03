'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(config.DATA_DIR, 'avatars'), { recursive: true });

const db = new Database(path.join(config.DATA_DIR, 'luckydraw.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  openid       TEXT UNIQUE,
  nickname     TEXT NOT NULL,
  avatar       TEXT,
  source       TEXT NOT NULL DEFAULT 'wechat',   -- wechat | mock | manual | seed
  note         TEXT,                              -- 名单导入时的手机尾号/备注
  real_name    TEXT,                              -- 扫码填写的真实姓名
  phone        TEXT,                              -- 扫码填写的手机号
  dept         TEXT,                              -- 部门（选填）
  blocked      INTEGER NOT NULL DEFAULT 0,
  joined_at    INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_blocked ON users(blocked);

CREATE TABLE IF NOT EXISTS rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  seq          INTEGER NOT NULL,
  name         TEXT NOT NULL,
  prize_name   TEXT NOT NULL,
  prize_image  TEXT,
  winner_count INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | drawn
  created_at   INTEGER NOT NULL,
  drawn_at     INTEGER
);

-- user_id 全局 UNIQUE：数据库层硬保证「不可重复中奖」（含弃奖者，抽中过即出局）
CREATE TABLE IF NOT EXISTS winners (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  status    TEXT NOT NULL DEFAULT 'valid',       -- valid | voided(弃奖)
  won_at    INTEGER NOT NULL,
  UNIQUE(user_id)
);
CREATE INDEX IF NOT EXISTS idx_winners_round ON winners(round_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---- 增量迁移：扫码资料字段（存量库自动补列） ----
const userCols = db.prepare(`SELECT name FROM pragma_table_info('users')`).all().map((r) => r.name);
if (!userCols.includes('real_name')) db.exec(`ALTER TABLE users ADD COLUMN real_name TEXT`);
if (!userCols.includes('phone')) db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
if (!userCols.includes('dept')) db.exec(`ALTER TABLE users ADD COLUMN dept TEXT`);

// ---- settings 初始化 ----
const DEFAULT_SETTINGS = {
  activity_title: '年度盛典 · 幸运抽奖',
  activity_subtitle: '扫码参与 · 好运连连',
  sign_in_enabled: '1',
  profile_form_enabled: '1',   // 扫码后需填写资料（姓名/手机号）
  current_round_id: '',
  phase: 'idle',            // idle | ready | rolling | reveal
  state_version: '1',
};
const insSetting = db.prepare(
  `INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=value`
);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, String(v));

module.exports = db;
