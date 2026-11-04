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

// v25 架构（云端优先）：配置与用户归云端，本地只拥有「运行态」——执行方写入
const OWNED_SETTINGS = ['current_round_id', 'phase'];
// 云端拥有、随拉取回流本地的设置键
const CLOUD_OWNED_SETTINGS = ['activity_title', 'activity_subtitle', 'profile_form_enabled', 'sign_in_enabled', 'group_reveal_threshold', 'gift_note'];

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

/** 增量拉取：新用户 + 变更用户（入池/资料更新）+ 头像文件（回流到本地） */
async function pullOnce() {
  // 全量重置尚未被云端确认时暂停拉取，防止旧用户回流复活
  if (state.getSyncState('clear_users_flag', '0') === '1') return 0;
  const since = parseInt(state.getSyncState('pull_watermark', '0'), 10) || 0;
  const sinceTs = parseInt(state.getSyncState('pull_ts', '0'), 10) || 0;
  const resp = await fetchWithTimeout(
    `${config.CLOUD_URL}/api/sync/pull?since_id=${since}&since_ts=${sinceTs}`,
    { headers: pairHeaders },
    6000
  );
  if (!resp.ok) throw new Error(`pull HTTP ${resp.status}`);
  const data = await resp.json();

  let newCount = 0;
  let changed = false;

  // ① 用户（增量：新用户 + 入池/资料变更）
  let maxId = since;
  for (const u of data.users || []) {
    const r = db.transaction(() => require('./users').upsertPulledUser(u))();
    if (r === 'new') newCount++;
    if (r) changed = true;
    if (u.id > maxId) maxId = u.id;
  }
  state.setSyncState('pull_watermark', String(maxId));
  state.setSyncState('pull_ts', String(data.server_time || Date.now()));

  // ② 奖品/轮次配置（云端为主，全量替换；本地不再编辑轮次）
  if (Array.isArray(data.rounds) && data.rounds.length >= 0) {
    db.transaction(() => {
      db.prepare('DELETE FROM rounds').run();
      const ins = db.prepare(
        `INSERT INTO rounds(id, seq, name, prize_name, prize_image, winner_count, status, created_at, drawn_at)
         VALUES(?,?,?,?,?,?,?,?,?)`
      );
      for (const r of data.rounds) {
        ins.run(r.id, r.seq, r.name, r.prize_name, r.prize_image || null, r.winner_count, r.status, r.created_at, r.drawn_at || null);
      }
      // 本地已开出结果的轮次，以本地结果为准（推送回写云端前的过渡一致性）
      db.prepare(
        `UPDATE rounds SET status='drawn',
           drawn_at=COALESCE(drawn_at,(SELECT MAX(won_at) FROM winners w WHERE w.round_id=rounds.id))
         WHERE id IN (SELECT DISTINCT round_id FROM winners)`
      ).run();
    })();
    changed = true;
  }

  // ③ 云端拥有的活动设置
  if (data.settings) {
    for (const k of CLOUD_OWNED_SETTINGS) {
      if (data.settings[k] !== undefined && state.getSetting(k, null) !== data.settings[k]) {
        state.setSetting(k, data.settings[k], { silent: true });
        changed = true;
      }
    }
  }

  // ④ 头像文件落盘（缺失才拉，失败落回本地 SVG 兜底）
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

  if (changed) state.bumpVersion(); // 配置/用户变化 → 大屏与管理台刷新
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

  // v25：本地只上传统治数据——中奖结果 / 补录用户 / 运行态（当前轮+相位）
  // 奖品轮次与活动配置归云端（本地拉取回流），不再随推送覆盖
  const winners = db.prepare('SELECT * FROM winners ORDER BY id').all();
  const manualUsers = db.prepare(`SELECT * FROM users WHERE id < 0`).all();
  const settings = {};
  for (const k of OWNED_SETTINGS) settings[k] = state.getSetting(k);
  const snapshot = {
    beat_at: Date.now(),
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

/** 操作员手动「立即同步」：强制拉取 + 有脏标则立即推送，返回明细 */
async function syncNow() {
  if (config.ROLE !== 'local') {
    return { ok: false, error: '当前为单机/云端模式，无同步任务' };
  }
  const pulled = await pullOnce(); // 拉取失败会抛出
  let pushed = false;
  if (state.getSyncState('dirty', '0') === '1') {
    await pushOnce();
    pushed = true;
  }
  return { ok: true, pulled_new_users: pulled, pushed_snapshot: pushed, status: status() };
}

module.exports = { markDirty, pullOnce, pushOnce, forcePull, syncNow, status, start };
