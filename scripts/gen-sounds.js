'use strict';
/**
 * 音效生成器：用 Node.js 合成高质量 WAV 音频（零外部依赖）
 * 用法：node scripts/gen-sounds.js
 * 输出：public/sounds/*.wav
 */
const fs = require('fs');
const path = require('path');

const SR = 44100; // 采样率
const OUT = path.join(__dirname, '..', 'public', 'sounds');
fs.mkdirSync(OUT, { recursive: true });

// ============ WAV 编码器 ============
function writeWav(filename, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(path.join(OUT, filename), buf);
  console.log(`✓ ${filename} (${(n / SR).toFixed(2)}s, ${(buf.length / 1024).toFixed(0)}KB)`);
}

// ============ 合成工具 ============
const T = (sec) => Math.floor(sec * SR);

/** 包络：快攻击 + 指数衰减 */
function env(i, n, attack = 0.01, decay = 3) {
  const t = i / n;
  const a = Math.min(1, i / (attack * SR));
  return a * Math.exp(-t * decay);
}

/** 正弦 */
function sine(freq, i) { return Math.sin(2 * Math.PI * freq * i / SR); }

/** 锯齿（丰富的泛音） */
function saw(freq, i) { return 2 * ((freq * i / SR) % 1) - 1; }

/** 方波 */
function square(freq, i) { return ((freq * i / SR) % 1) < 0.5 ? 1 : -1; }

/** 噪声 */
function noise() { return Math.random() * 2 - 1; }

/** 简单低通滤波 */
function lowpass(data, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / SR;
  const alpha = dt / (rc + dt);
  const out = new Float64Array(data.length);
  let prev = 0;
  for (let i = 0; i < data.length; i++) {
    prev += alpha * (data[i] - prev);
    out[i] = prev;
  }
  return out;
}

/** 混响（简单延迟叠加） */
function reverb(data, delayMs = 80, mix = 0.3) {
  const d = Math.floor(delayMs / 1000 * SR);
  const out = new Float64Array(data.length + d);
  for (let i = 0; i < data.length; i++) {
    out[i] += data[i];
    out[i + d] += data[i] * mix;
  }
  return out;
}

// ============ 音效生成 ============

/** 1. 号角（Fanfare）：铜管和弦进行曲 */
function genFanfare() {
  const dur = 2.5; const n = T(dur); const out = new Float64Array(n);
  // C → F → G → C 进行
  const chords = [
    { freqs: [262, 330, 392, 523], start: 0, len: 0.45 },
    { freqs: [349, 440, 523, 698], start: 0.5, len: 0.45 },
    { freqs: [392, 494, 587, 784], start: 1.0, len: 0.45 },
    { freqs: [262, 330, 392, 523, 659, 784, 1047], start: 1.5, len: 1.0 },
  ];
  // 号角旋律
  const melody = [
    { f: 523, t: 0, d: 0.12 }, { f: 659, t: 0.12, d: 0.12 }, { f: 784, t: 0.24, d: 0.18 },
    { f: 1047, t: 1.5, d: 0.3 }, { f: 1319, t: 1.75, d: 0.5 },
  ];
  for (const c of chords) {
    for (const f of c.freqs) {
      const s = T(c.start), e = T(c.start + c.len);
      for (let i = s; i < e && i < n; i++) {
        const e2 = env(i - s, e - s, 0.02, 2.5);
        out[i] += (saw(f, i) * 0.3 + saw(f * 2, i) * 0.15 + saw(f * 3, i) * 0.08) * e2 * 0.12;
      }
    }
  }
  for (const m of melody) {
    const s = T(m.t), e = T(m.t + m.d);
    for (let i = s; i < e && i < n; i++) {
      out[i] += (saw(m.f, i) * 0.4 + saw(m.f * 2, i) * 0.2 + sine(m.f * 3, i) * 0.1) * env(i - s, e - s, 0.01, 3) * 0.2;
    }
  }
  // 镲片
  for (let i = T(1.5); i < T(2.3) && i < n; i++) out[i] += noise() * 0.08 * Math.exp(-(i - T(1.5)) / SR * 5);
  // 定音鼓
  for (let i = 0; i < n; i += T(0.25)) for (let j = 0; j < T(0.1) && i + j < n; j++) out[i + j] += sine(60, j) * Math.exp(-j / SR * 30) * 0.25;
  writeWav('fanfare.wav', reverb(lowpass(out, 8000), 60, 0.25));
}

/** 2. 鼓声滚奏（Drum Roll）：军鼓连续击打 */
function genDrumroll() {
  const dur = 5; const n = T(dur); const out = new Float64Array(n);
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const interval = 0.06; // 击打间隔
    if (i >= hit) {
      const burst = T(0.03);
      for (let j = 0; j < burst && i + j < n; j++) {
        out[i + j] += noise() * Math.exp(-j / burst * 4) * 0.3;
      }
      hit = i + T(interval);
    }
  }
  writeWav('drumroll.wav', lowpass(out, 6000));
}

/** 3. 老虎机中奖（Slot Win）：快速上升叮叮叮 */
function genSlotWin() {
  const dur = 2.5; const n = T(dur); const out = new Float64Array(n);
  const notes = [523, 659, 784, 1047, 1319, 1568, 2093]; // 上行
  notes.forEach((f, k) => {
    const s = T(k * 0.18), e = T(k * 0.18 + 0.5);
    for (let i = s; i < e && i < n; i++) {
      out[i] += (sine(f, i) * 0.35 + sine(f * 2, i) * 0.2 + sine(f * 3, i) * 0.1) * env(i - s, e - s, 0.005, 4);
    }
  });
  // 尾声：胜利和弦长鸣
  for (let i = T(1.4); i < n; i++) {
    const t = (i - T(1.4)) / SR;
    [523, 659, 784, 1047].forEach(f => out[i] += sine(f, i) * 0.15 * Math.exp(-t * 2));
  }
  writeWav('slot_win.wav', reverb(out, 50, 0.2));
}

/** 4. 胜利钟声（Win Chime）：明亮钟琴 */
function genWinChime() {
  const dur = 1.5; const n = T(dur); const out = new Float64Array(n);
  [1047, 1319, 1568].forEach((f, k) => {
    const s = T(k * 0.06);
    for (let i = s; i < n; i++) {
      out[i] += sine(f, i) * 0.3 * Math.exp(-(i - s) / SR * 3);
      out[i] += sine(f * 2.76, i) * 0.1 * Math.exp(-(i - s) / SR * 5); // 钟音非谐波
    }
  });
  writeWav('win_chime.wav', reverb(out, 80, 0.3));
}

/** 5. 人群欢呼（Cheer）：白噪+粉噪+调制模拟 */
function genCheer() {
  const dur = 3; const n = T(dur); const out = new Float64Array(n);
  let lfo = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t) * Math.sin(2 * Math.PI * 0.5 * t);
    const swell = Math.min(1, t / 0.3) * Math.exp(-t * 0.8);
    out[i] = (noise() * 0.15 + Math.sin(2 * Math.PI * 400 * t + Math.sin(2 * Math.PI * 8 * t) * 100) * 0.05) * swell * lfo;
  }
  writeWav('cheer.wav', lowpass(out, 4000));
}

/** 6. 低频冲击（Impact）：Sub Drop */
function genImpact() {
  const dur = 0.8; const n = T(dur); const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const freq = 200 * Math.exp(-t * 5) + 25; // 200→25Hz
    out[i] = sine(freq, i) * 0.7 * Math.exp(-t * 3);
    out[i] += noise() * 0.15 * Math.exp(-t * 30);
  }
  writeWav('impact.wav', lowpass(out, 2000));
}

/** 7. 成就铃（Bell）*/
function genBell() {
  const dur = 1.2; const n = T(dur); const out = new Float64Array(n);
  [880, 1320, 1760, 2640].forEach((f, k) => {
    const vol = [0.3, 0.15, 0.08, 0.04][k];
    for (let i = 0; i < n; i++) out[i] += sine(f, i) * vol * Math.exp(-i / SR * (3 + k * 2));
  });
  writeWav('bell.wav', reverb(out, 100, 0.35));
}

/** 8. 电影级冲击（Trailer Hit）*/
function genTrailerHit() {
  const dur = 1.5; const n = T(dur); const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const freq = 150 * Math.exp(-t * 4) + 30;
    out[i] = sine(freq, i) * 0.6 * Math.exp(-t * 2.5);
    out[i] += saw(80 * Math.exp(-t * 3) + 20, i) * 0.2 * Math.exp(-t * 4);
    if (t < 0.05) out[i] += noise() * 0.3;
  }
  // 混响尾音
  const rev = reverb(out, 120, 0.4);
  writeWav('trailer_hit.wav', lowpass(rev, 6000));
}

/** 9. 悬念鼓点（Suspense）*/
function genSuspense() {
  const dur = 4; const n = T(dur); const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = Math.floor(t / 0.5);
    const phase = (t % 0.5) / 0.5;
    if (phase < 0.15) {
      out[i] += sine(80, i) * Math.exp(-phase * 20) * 0.35;
      out[i] += noise() * Math.exp(-phase * 25) * 0.1;
    }
  }
  writeWav('suspense.wav', lowpass(out, 3000));
}

/** 10. 大奖警报（Jackpot）*/
function genJackpot() {
  const dur = 3; const n = T(dur); const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cycle = Math.floor(t / 0.15) % 2;
    const f = cycle === 0 ? 880 : 1100;
    out[i] += (square(f, i) * 0.15 + sine(f, i) * 0.15) * Math.min(1, t / 0.05) * (t < 2.5 ? 1 : Math.exp(-(t - 2.5) * 3));
  }
  writeWav('jackpot.wav', lowpass(out, 5000));
}

// ============ 执行 ============
console.log('生成音效文件...');
genFanfare();
genDrumroll();
genSlotWin();
genWinChime();
genCheer();
genImpact();
genBell();
genTrailerHit();
genSuspense();
genJackpot();
console.log('完成！共 10 个 WAV 文件');
