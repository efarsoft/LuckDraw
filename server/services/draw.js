'use strict';
const db = require('../db');
const state = require('./state');
const sync = require('./sync'); // 仅调用 markDirty，见文末说明

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const listRounds = () => db.prepare('SELECT * FROM rounds ORDER BY seq ASC, id ASC').all();
const getRound = (id) => db.prepare('SELECT * FROM rounds WHERE id = ?').get(id);

const listWinners = () =>
  db
    .prepare(
      `SELECT w.id, w.round_id, w.user_id, w.status, w.won_at,
              COALESCE(NULLIF(u.real_name,''), u.nickname) AS nickname, u.avatar, u.note, u.phone
       FROM winners w LEFT JOIN users u ON u.id = w.user_id
       ORDER BY w.won_at ASC, w.id ASC`
    )
    .all();

const listWinnersByRound = (roundId) =>
  db
    .prepare(
      `SELECT w.id, w.round_id, w.user_id, w.status, w.won_at,
              COALESCE(NULLIF(u.real_name,''), u.nickname) AS nickname, u.avatar, u.note, u.phone
       FROM winners w LEFT JOIN users u ON u.id = w.user_id
       WHERE w.round_id = ? ORDER BY w.id ASC`
    )
    .all(roundId);

/** 奖池：未中奖且未被排除的全部用户 */
function poolCount() {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM users
       WHERE blocked = 0 AND in_pool = 1 AND id NOT IN (SELECT user_id FROM winners)`
    )
    .get().c;
}

/** 抽取核心：单事务「抽取 + 落库 + 状态翻转」，幂等（已抽轮次直接返回现有结果） */
function drawRound(roundId, { redraw = false } = {}) {
  const round = getRound(roundId);
  if (!round) throw new AppError(404, '轮次不存在');

  if (round.status === 'drawn' && !redraw) {
    return listWinnersByRound(roundId); // 双击/网络重试幂等
  }

  const need = redraw
    ? round.winner_count - validCount(roundId) // 补抽：补齐有效名额
    : round.winner_count;

  if (redraw && need <= 0) throw new AppError(409, '本轮名额已满，无需补抽');

  const result = db.transaction(() => {
    const pool = db
      .prepare(
        `SELECT id FROM users
         WHERE blocked = 0 AND in_pool = 1 AND id NOT IN (SELECT user_id FROM winners)
         ORDER BY RANDOM() LIMIT ?`
      )
      .all(need)
      .map((r) => r.id);

    if (pool.length === 0) throw new AppError(409, '奖池已空，无候选用户');

    const now = Date.now();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO winners(round_id, user_id, status, won_at) VALUES(?, ?, 'valid', ?)`
    );
    const inserted = [];
    for (const uid of pool) {
      const r = ins.run(roundId, uid, now);
      if (r.changes > 0) inserted.push(uid); // UNIQUE 兜底：极端并发下重复者被拒
    }
    db.prepare(`UPDATE rounds SET status = 'drawn', drawn_at = ? WHERE id = ?`).run(now, roundId);
    state.setSetting('phase', 'reveal', { silent: true });
    state.setSetting('current_round_id', roundId, { silent: true });
    state.bumpVersion();
    return { round: getRound(roundId), winners: listWinnersByRound(roundId), poolExhausted: pool.length < need };
  })();

  sync.markDirty(); // 结果待回传云端
  return result;
}

function validCount(roundId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM winners WHERE round_id = ? AND status = 'valid'`).get(roundId).c;
}

/** 弃奖：名额作废，人出局（抽中过即不再参与后续轮次），可再补抽 */
function voidWinner(winnerId) {
  const w = db.prepare('SELECT * FROM winners WHERE id = ?').get(winnerId);
  if (!w) throw new AppError(404, '中奖记录不存在');
  if (w.status === 'voided') return; // 幂等
  db.transaction(() => {
    db.prepare(`UPDATE winners SET status = 'voided' WHERE id = ?`).run(winnerId);
    state.bumpVersion();
  })();
  sync.markDirty();
}

/** 整轮回滚：该轮中奖记录全部删除，用户释放回奖池，轮次回到待抽 */
function rollbackRound(roundId) {
  const round = getRound(roundId);
  if (!round) throw new AppError(404, '轮次不存在');
  db.transaction(() => {
    db.prepare('DELETE FROM winners WHERE round_id = ?').run(roundId);
    db.prepare(`UPDATE rounds SET status = 'pending', drawn_at = NULL WHERE id = ?`).run(roundId);
    state.bumpVersion();
  })();
  sync.markDirty();
}

function nextSeq() {
  return db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM rounds').get().m + 1;
}

function createRound({ seq, name, prize_name, prize_image, winner_count }) {
  const count = parseInt(winner_count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new AppError(400, '每轮中奖人数须为 1~500');
  const finalSeq = Number.isInteger(parseInt(seq, 10)) ? parseInt(seq, 10) : nextSeq();
  const info = db
    .prepare(
      `INSERT INTO rounds(seq, name, prize_name, prize_image, winner_count, status, created_at)
       VALUES(?,?,?,?,?,'pending',?)`
    )
    .run(finalSeq, String(name || `第${finalSeq}轮`).slice(0, 50), String(prize_name || '幸运大奖').slice(0, 100), prize_image || null, count, Date.now());
  state.bumpVersion();
  sync.markDirty();
  return getRound(info.lastInsertRowid);
}

function updateRound(id, patch) {
  const round = getRound(id);
  if (!round) throw new AppError(404, '轮次不存在');
  const fields = {};
  for (const k of ['seq', 'name', 'prize_name', 'prize_image', 'winner_count']) {
    if (patch[k] !== undefined) fields[k] = patch[k];
  }
  if (Object.keys(fields).length) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE rounds SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
    state.bumpVersion();
    sync.markDirty();
  }
  return getRound(id);
}

function deleteRound(id) {
  const round = getRound(id);
  if (!round) throw new AppError(404, '轮次不存在');
  db.transaction(() => {
    db.prepare('DELETE FROM winners WHERE round_id = ?').run(id);
    db.prepare('DELETE FROM rounds WHERE id = ?').run(id);
    if (String(state.getSetting('current_round_id')) === String(id)) {
      state.setSetting('current_round_id', '', { silent: true });
      state.setSetting('phase', 'idle', { silent: true });
    }
    state.bumpVersion();
  })();
  sync.markDirty();
}

/** 主持人选中某轮 / 切换大屏阶段 */
function selectRound(id) {
  const round = getRound(id);
  if (!round) throw new AppError(404, '轮次不存在');
  db.transaction(() => {
    state.setSetting('current_round_id', id, { silent: true });
    state.setSetting('phase', round.status === 'drawn' ? 'reveal' : 'ready', { silent: true });
    state.bumpVersion();
  })();
  sync.markDirty();
}

function setPhase(phase) {
  if (!['idle', 'ready', 'rolling', 'reveal'].includes(phase)) throw new AppError(400, '非法阶段');
  state.setSetting('phase', phase);
  sync.markDirty();
}

/** 清空中奖（彩排重置）：所有轮次回到待抽，winners 清空 */
function resetWinners() {
  db.transaction(() => {
    db.prepare('DELETE FROM winners').run();
    db.prepare(`UPDATE rounds SET status = 'pending', drawn_at = NULL`).run();
    state.setSetting('phase', 'idle', { silent: true });
    state.setSetting('current_round_id', '', { silent: true });
    state.bumpVersion();
  })();
  sync.markDirty();
}

module.exports = {
  AppError,
  listRounds,
  getRound,
  listWinners,
  listWinnersByRound,
  poolCount,
  drawRound,
  voidWinner,
  rollbackRound,
  createRound,
  updateRound,
  deleteRound,
  selectRound,
  setPhase,
  resetWinners,
  nextSeq,
};

// 循环依赖处理：sync 仅在运行期使用 db，此处 require 放文件尾避免初始化环
// （services/sync.js 顶层不反向 require draw.js）
