'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const state = require('./state');
const avatarLib = require('../lib/avatar');

/**
 * 同步引擎（仅 ROLE=local 启动）：
 *  - 回流：增量拉取云端签到用户（显式沿用云端 id）+ 头像文件落盘 → 断外网后大屏/抽奖照常
 *  - 回传：脏快照推送（rounds/winners/手动用户/设置）+ 心跳；ACK 才清脏标，断网期间持久保留
 * 云端 = users 唯一写入方；本地 = rounds/winners 唯一写入方 → 无冲突。
 */

let started = false;
let pushTimer = null;
let pullTimer = null;
let lastPushAttempt = 0;
let backoffMs = 1000;         // 失败退避，封顶 30s
let pushFailCount = 0;
let heartbeatDue = 0;
let immediatePush = null;     // markDirty 触发的立即推送（去抖）

const OWNED_SETTINGS = ['activity_title', 'activity_subtitle', 'sign_in_enabled', 'current_round_id', 'phase', 'group_reveal_threshold'];

function markDirty() {
  try {
    state.setSyncState('dirty', '1');
    // 去抖立即尝试推送（1s 内合并）
    if (!immediatePush) {
      immediatePush = setTimeout(() => {
        immediatePush = null;
        pushOnce().catch(() => {});
      }, 1000);
      immediatePush.unref?.();
    }
  } catch {
    /* 同步失败不影响主流程 */
  }
}

function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const pairHeaders = { 'x-pair-key': config.PAIR_KEY, 'content-type': 'application/json' };

/** 增量拉取：新用户 + 头像文件（回流到本地） */
async function pullOnce() {
  // 全量重置尚未被云端确认时暂停拉取，防止旧用户回流复活
  if (state.getSyncState('clear_users_flag', '0') === '1') return 0;
  const since = parseInt(state.getSyncState('pull_watermark', '0'), 10) || 0;
  const resp = await fetchWithTimeout(
    `${config.CLOUD_URL}/api/sync/pull?since_id=${since}`,
    { headers: pairHeaders },
    6000
  );
  if (!resp.ok) throw new Error(`pull HTTP ${resp.status}`);
  const data = await resp.json();

  let newCount = 0;
  for (const u of data.users || []) {
    const inserted = db.transaction(() => require('./users').upsertPulledUser(u))();
    if (inserted) {
      newCount++;
      state.setSyncState('pull_watermark', String(Math.max(since, u.id)), );
    }
  }
  if (newCount > 0) state.bumpVersion(); // 大屏签到人数/头像墙更新

  // 头像文件落盘（缺失才拉，失败落回本地 SVG 兜底）
  const updAvatar = db.prepare('UPDATE users SET avatar = ? WHERE id = ?');
  for (const u of data.users || []) {
    if (!u.avatar) continue;
    const localPath = path.join(avatarLib.AVATAR_DIR, u.avatar);
    if (fs.existsSync(localPath)) continue;
    let ok = false;
    try {
      const aresp = await fetchWithTimeout(
        `${config.CLOUD_URL}/api/sync/avatar?file=${encodeURIComponent(u.avatar)}`,
        { headers: { 'x-pair-key': config.PAIR_KEY } },
        8000
      );
      if (aresp.ok) {
        const buf = Buffer.from(await aresp.arrayBuffer());
        if (buf.length > 0 && buf.length <= 2 * 1024 * 1024) {
          fs.writeFileSync(localPath, buf);
          ok = true;
        }
      }
    } catch {
      /* 云端不可达时用本地兜底头像 */
    }
    if (!ok) {
      const fallback = avatarLib.generateInitialAvatar(u.nickname);
      db.transaction(() => updAvatar.run(fallback, u.id))();
    }
  }

  state.setSyncState('last_pull_ok_at', String(Date.now()));
  state.setSyncState('last_error', '');
  return newCount;
}

/** 脏快照推送 + 心跳（断网时失败保留脏标，恢复后自动续传） */
async function pushOnce({ heartbeatOnly = false } = {}) {
  const dirty = state.getSyncState('dirty', '0') === '1';
  if (!dirty && heartbeatOnly) {
    // 无脏数据也要心跳，云端据此展示数据新鲜度
    const resp = await fetchWithTimeout(
      `${config.CLOUD_URL}/api/sync/heartbeat`,
      { method: 'POST', headers: pairHeaders, body: JSON.stringify({ beat_at: Date.now() }) },
      5000
    );
    if (!resp.ok) throw new Error(`heartbeat HTTP ${resp.status}`);
    state.setSyncState('last_push_ok_at', String(Date.now()));
    state.setSyncState('last_error', '');
    return;
  }
  if (!dirty) return;

  // 关键：发送前先清脏标（clear-before-send）。
  // 推送飞行途中若有新变更（如开奖），其 markDirty 会重新置 1，不会被本次成功回执清掉 —— 杜绝 lost-update。
  state.setSyncState('dirty', '0');

  const rounds = db.prepare('SELECT * FROM rounds ORDER BY id').all();
  const winners = db.prepare('SELECT * FROM winners ORDER BY id').all();
  const manualUsers = db.prepare(`SELECT * FROM users WHERE id < 0`).all();
  const settings = {};
  for (const k of OWNED_SETTINGS) settings[k] = state.getSetting(k);
  const snapshot = {
    beat_at: Date.now(),
    rounds,
    winners,
    manual_users: manualUsers,
    settings,
    stats: { pool: require('./draw').poolCount(), users: db.prepare('SELECT COUNT(*) c FROM users').get().c },
  };
  if (state.getSyncState('clear_users_flag', '0') === '1') snapshot.clear_users = true;

  try {
    const resp = await fetchWithTimeout(
      `${config.CLOUD_URL}/api/sync/push`,
      { method: 'POST', headers: pairHeaders, body: JSON.stringify(snapshot) },
      8000
    );
    if (!resp.ok) throw new Error(`push HTTP ${resp.status}`);
    const ack = await resp.json().catch(() => ({}));
    if (ack.ok !== true) throw new Error(ack.error || 'push rejected');
    if (snapshot.clear_users) state.setSyncState('clear_users_flag', '0'); // 云端已确认清空
    state.setSyncState('last_push_ok_at', String(Date.now()));
    state.setSyncState('last_error', '');
  } catch (e) {
    state.setSyncState('dirty', '1'); // 失败回滚脏标，等待重试
    throw e;
  }
}

/** 开奖前强制拉取（best-effort，收拢迟到签到；云端不可达则用当前奖池） */
async function forcePull() {
  try {
    await pullOnce();
    return true;
  } catch (e) {
    state.setSyncState('last_error', String(e.message || e));
    return false;
  }
}

function status() {
  const now = Date.now();
  const lastPull = parseInt(state.getSyncState('last_pull_ok_at', '0'), 10) || 0;
  const lastPush = parseInt(state.getSyncState('last_push_ok_at', '0'), 10) || 0;
  const lastOk = Math.max(lastPull, lastPush);
  const linked = lastOk > 0 && now - lastOk < config.SYNC_PUSH_INTERVAL_MS * 3;
  return {
    mode: config.ROLE,
    cloud_url: config.CLOUD_URL,
    linked,
    dirty: state.getSyncState('dirty', '0') === '1',
    last_pull_ok_at: lastPull || null,
    last_push_ok_at: lastPush || null,
    last_error: state.getSyncState('last_error', ''),
    pull_watermark: parseInt(state.getSyncState('pull_watermark', '0'), 10) || 0,
  };
}

function start() {
  if (started || config.ROLE !== 'local') return;
  started = true;

  pullTimer = setInterval(async () => {
    try {
      await pullOnce();
    } catch (e) {
      state.setSyncState('last_error', String(e.message || e));
    }
  }, config.SYNC_PULL_INTERVAL_MS);
  pullTimer.unref?.();

  pushTimer = setInterval(async () => {
    // 失败退避：连续失败时降低尝试频率，封顶 30s
    if (Date.now() - lastPushAttempt < backoffMs - 500) return;
    lastPushAttempt = Date.now();
    try {
      await pushOnce({ heartbeatOnly: true }); // 有脏标时推快照，否则只心跳
      pushFailCount = 0;
      backoffMs = 1000;
    } catch (e) {
      pushFailCount++;
      backoffMs = Math.min(30_000, backoffMs * 2);
      state.setSyncState('last_error', String(e.message || e));
    }
  }, config.SYNC_PUSH_INTERVAL_MS);
  pushTimer.unref?.();
}

module.exports = { markDirty, pullOnce, pushOnce, forcePull, status, start };
