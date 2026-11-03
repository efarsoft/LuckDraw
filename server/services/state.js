'use strict';
const { EventEmitter } = require('events');
const db = require('../db');

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  `INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
const bumpStmt = db.prepare(
  `UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = 'state_version'`
);

function getSetting(key, def = '') {
  const row = getStmt.get(key);
  return row ? row.value : def;
}

/** 写设置并全局广播（可静默跳过版本号更新） */
function setSetting(key, value, { silent = false } = {}) {
  setStmt.run(key, String(value));
  if (!silent) bumpVersion();
}

function getVersion() {
  return parseInt(getSetting('state_version', '1'), 10) || 1;
}

function bumpVersion() {
  bumpStmt.run();
  emitter.emit('change', getVersion());
}

/** 等待版本变化；返回是否在超时内变化（用于长轮询） */
function waitForChange(fromVersion, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (changed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      emitter.removeListener('change', onChange);
      resolve(changed);
    };
    const onChange = (v) => finish(v !== fromVersion);
    const timer = setTimeout(() => finish(false), timeoutMs);
    emitter.on('change', onChange);
  });
}

// ---- sync_state（仅本地/同步用，不参与版本号） ----
const syncGetStmt = db.prepare('SELECT value FROM sync_state WHERE key = ?');
const syncSetStmt = db.prepare(
  `INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
function getSyncState(key, def = '') {
  const row = syncGetStmt.get(key);
  return row ? row.value : def;
}
function setSyncState(key, value) {
  syncSetStmt.run(key, String(value));
}

module.exports = { getSetting, setSetting, getVersion, bumpVersion, waitForChange, getSyncState, setSyncState, emitter };
