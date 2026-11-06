/* ============ 大屏页：长轮询 + 转盘动画 + 揭晓序列 + 音效 ============ */
(function () {
  const $ = (id) => document.getElementById(id);
  let cur = null;
  let prevSig = null;
  let pollV = 0;

  // ---------- 星域背景（星尘闪烁 + 流星，Canvas） ----------
  const starfield = (() => {
    const cv = $('starfield');
    const ctx = cv.getContext('2d');
    let stars = [], meteors = [], W = 0, H = 0, nextMeteor = 2500;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = W * DPR; cv.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      stars = Array.from({ length: Math.round((W * H) / 14000) }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: 0.5 + Math.random() * 1.7,
        base: 0.15 + Math.random() * 0.5,
        amp: 0.1 + Math.random() * 0.35,
        spd: 0.4 + Math.random() * 1.6,
        ph: Math.random() * Math.PI * 2,
        warm: Math.random() < 0.6, // 金色调为主，少量冷白
      }));
    }
    window.addEventListener('resize', () => setTimeout(resize, 200));
    resize();
    function spawnMeteor() {
      // 从上半区斜向划过
      const x = W * (0.15 + Math.random() * 0.7), y = H * (0.05 + Math.random() * 0.3);
      const ang = Math.PI * (0.72 + Math.random() * 0.12);
      const sp = 620 + Math.random() * 420;
      meteors.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.42, life: 0, ttl: 0.85 + Math.random() * 0.5 });
    }
    function frame(dt, t) {
      ctx.clearRect(0, 0, W, H);
      for (const s of stars) {
        const a = s.base + Math.sin(t / 1000 * s.spd + s.ph) * s.amp;
        if (a <= 0.02) continue;
        ctx.globalAlpha = Math.min(1, a);
        ctx.fillStyle = s.warm ? '#ffd98a' : '#ffffff';
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        if (s.r > 1.5) { // 大星带十字光芒
          ctx.globalAlpha = Math.min(0.5, a * 0.55);
          ctx.fillRect(s.x - s.r * 3, s.y - 0.5, s.r * 6, 1);
          ctx.fillRect(s.x - 0.5, s.y - s.r * 3, 1, s.r * 6);
        }
      }
      // 流星
      nextMeteor -= dt * 1000;
      if (nextMeteor <= 0) { spawnMeteor(); nextMeteor = 3800 + Math.random() * 5200; }
      meteors = meteors.filter((m) => m.life < m.ttl);
      for (const m of meteors) {
        m.life += dt; m.x += m.vx * dt; m.y += m.vy * dt;
        const k = 1 - m.life / m.ttl;
        const len = 130 * k + 40;
        const nx = m.vx / Math.hypot(m.vx, m.vy), ny = m.vy / Math.hypot(m.vx, m.vy);
        const grad = ctx.createLinearGradient(m.x, m.y, m.x - nx * len, m.y - ny * len);
        grad.addColorStop(0, `rgba(255,240,190,${0.85 * k})`);
        grad.addColorStop(0.3, `rgba(255,200,90,${0.5 * k})`);
        grad.addColorStop(1, 'rgba(255,200,90,0)');
        ctx.globalAlpha = 1;
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.x - nx * len, m.y - ny * len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    return { frame };
  })();

  // ---------- 音效（WebAudio 合成，无音频文件） ----------
  const AudioFX = {
    ctx: null,
    muted: localStorage.getItem('ld_muted') === '1',
    ensure() {
      if (this.muted) return null;
      if (!this.ctx) {
        try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, t0, dur, type = 'triangle', vol = 0.22, slideTo = null) {
      const ctx = this.ensure();
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime + t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + t0 + dur * 0.8);
      g.gain.setValueAtTime(0, ctx.currentTime + t0);
      g.gain.linearRampToValueAtTime(vol, ctx.currentTime + t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + dur);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t0);
      o.stop(ctx.currentTime + t0 + dur + 0.05);
    },
    /** 噪声（军鼓/镲片/氛围） */
    noise(t0, dur, vol = 0.3, filterFreq = 6000, type = 'highpass') {
      const ctx = this.ensure();
      if (!ctx) return;
      const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.5);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const filt = ctx.createBiquadFilter(); filt.type = type; filt.frequency.value = filterFreq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, ctx.currentTime + t0);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + dur);
      src.connect(filt).connect(g).connect(ctx.destination);
      src.start(ctx.currentTime + t0);
    },
    /** 铜管音色（锯齿+泛音叠加，模拟号角） */
    brass(freq, t0, dur, vol = 0.15) {
      this.tone(freq, t0, dur, 'sawtooth', vol);
      this.tone(freq * 2, t0, dur, 'sawtooth', vol * 0.5);
      this.tone(freq * 3, t0, dur * 0.6, 'sawtooth', vol * 0.25);
    },
    chord(freqs, t0, dur, vol = 0.12, type = 'triangle') {
      freqs.forEach(f => this.tone(f, t0, dur, type, vol));
    },
    /** 中奖：JACKPOT！上升琶音 + 镲片 + 电影级低频冲击 */
    ding(i) {
      const base = 440 * Math.pow(1.059, i); // 每位递升半音，越抽越燃
      // 快速上升琶音（大三和弦跨两个八度）
      const arp = [base, base * 1.26, base * 1.5, base * 2, base * 2.52, base * 3];
      arp.forEach((f, k) => this.brass(f, k * 0.035, 0.18, 0.16));
      // 高音闪亮尾音
      this.tone(base * 4, 0.22, 0.3, 'sine', 0.18);
      // 镲片炸裂
      this.noise(0, 0.15, 0.25, 8000);
      this.noise(0, 0.4, 0.12, 12000);
      // 电影级低频冲击
      this.thump();
    },
    /** 寻人扫描：高频急促 */
    tick() {
      const ctx = this.ensure();
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(2800, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(2000, ctx.currentTime + 0.03);
      g.gain.setValueAtTime(0.1, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.035);
      o.connect(g).connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.04);
    },
    /** 电影级低频冲击（预告片 Sub-Drop） */
    thump() {
      const ctx = this.ensure();
      if (!ctx) return;
      // Layer 1: 超低频正弦（Sub Bass Drop 200→25Hz）
      const o1 = ctx.createOscillator(), g1 = ctx.createGain();
      o1.type = 'sine';
      o1.frequency.setValueAtTime(200, ctx.currentTime);
      o1.frequency.exponentialRampToValueAtTime(25, ctx.currentTime + 0.25);
      g1.gain.setValueAtTime(0.6, ctx.currentTime);
      g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o1.connect(g1).connect(ctx.destination);
      o1.start(); o1.stop(ctx.currentTime + 0.38);
      // Layer 2: 锯齿中频（Punch）
      const o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o2.type = 'sawtooth';
      o2.frequency.setValueAtTime(120, ctx.currentTime);
      o2.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.12);
      g2.gain.setValueAtTime(0.25, ctx.currentTime);
      g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      o2.connect(g2).connect(ctx.destination);
      o2.start(); o2.stop(ctx.currentTime + 0.2);
      // Layer 3: 噪声瞬态（Transient Snap）
      this.noise(0, 0.04, 0.18, 1500, 'bandpass');
    },
    /** 胜利号角：史诗级铜管进行曲 + 定音鼓 + 镲片齐鸣 */
    fanfare() {
      // 小号呼叫（前三连音上行）
      this.brass(523, 0, 0.15, 0.18);      // C4
      this.brass(659, 0.15, 0.15, 0.18);   // E4
      this.brass(784, 0.3, 0.2, 0.18);     // G4
      // 和弦进行：C → F → G → C（属七和弦更有张力）
      const chords = [
        { freqs: [262, 330, 392, 523],  t: 0.55, dur: 0.22 },  // C
        { freqs: [349, 440, 523, 698],  t: 0.82, dur: 0.22 },  // F
        { freqs: [392, 494, 587, 784],  t: 1.09, dur: 0.22 },  // G7
        { freqs: [262, 330, 392, 523, 659, 784, 1047], t: 1.36, dur: 1.0 }, // C 终曲大和弦
      ];
      chords.forEach(c => c.freqs.forEach(f => this.brass(f, c.t, c.dur, 0.09)));
      // 高潮旋律线（胜利号角旋律）
      this.brass(1047, 1.36, 0.35, 0.14);   // C6
      this.brass(1319, 1.6, 0.5, 0.12);     // E6
      this.brass(1568, 1.85, 0.6, 0.1);     // G6 长音
      // 定音鼓滚奏
      this.noise(0.5, 0.9, 0.08, 80, 'lowpass');
      // 镲片三连击
      this.noise(0.55, 0.8, 0.15, 10000);
      this.noise(1.36, 1.2, 0.2, 8000);
      this.noise(1.5, 0.6, 0.12, 12000);
      // 双重低频冲击
      this.thump();
      setTimeout(() => this.thump(), 300);
    },
    drumTimer: null,
    drumRollStep: 0,
    /** 滚动鼓点：加速摇滚节奏 */
    drumrollStart() {
      if (this.drumTimer || this.muted) return;
      this.drumRollStep = 0;
      const beat = () => {
        const ctx = this.ensure();
        if (!ctx) return;
        this.drumRollStep++;
        const step = this.drumRollStep % 4;
        if (step === 0 || step === 2) {
          // Kick（低鼓）
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(120, ctx.currentTime);
          o.frequency.exponentialRampToValueAtTime(35, ctx.currentTime + 0.09);
          g.gain.setValueAtTime(0.28, ctx.currentTime);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
          o.connect(g).connect(ctx.destination);
          o.start(); o.stop(ctx.currentTime + 0.14);
        } else if (step === 1) {
          // Snare（军鼓）
          this.noise(0, 0.06, 0.14, 3000, 'bandpass');
        } else {
          // Hi-hat（踩镲）
          this.noise(0, 0.03, 0.08, 9000, 'highpass');
        }
      };
      beat();
      this.drumTimer = setInterval(beat, 100);
    },
    drumrollStop() { clearInterval(this.drumTimer); this.drumTimer = null; this.drumRollStep = 0; },
  };
  $('btn-sound').textContent = AudioFX.muted ? '🔇' : '🔊';
  function toggleMute() {
    AudioFX.muted = !AudioFX.muted;
    localStorage.setItem('ld_muted', AudioFX.muted ? '1' : '0');
    $('btn-sound').textContent = AudioFX.muted ? '🔇' : '🔊';
    if (AudioFX.muted) AudioFX.drumrollStop();
  }
  $('btn-sound').onclick = toggleMute;
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  $('btn-full').onclick = toggleFull;

  // ================= 开奖控制（主持人在大屏直接开奖，复用管理端 API） =================
  const CTL = {
    authed: false,
    busy: false,
    async call(method, path, body) {
      const resp = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (resp.status === 401) {
        CTL.authed = false;
        updateLock();
        openKeyModal();
        throw new Error('请先登录管理员账号');
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      updateLock();
      return data;
    },
    async ensureKey() {
      if (CTL.authed) return true;
      // 已有会话则直接复用
      const me = await fetch('/api/admin/me', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (me) { CTL.authed = true; updateLock(); return true; }
      openKeyModal();
      return false;
    },
  };
  function updateLock() { $('ck-lock').textContent = CTL.authed ? '🔐' : '🔓'; }
  function openKeyModal() {
    $('key-modal').classList.remove('hidden');
    if (!$('ck-user').value) $('ck-user').focus(); else $('ck-key').focus();
  }
  async function submitKey() {
    const username = $('ck-user').value.trim();
    const password = $('ck-key').value;
    if (!username || !password) return showToast('请输入账号和密码');
    try {
      const resp = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return showToast(data.error || '账号或密码错误');
      CTL.authed = true;
      $('ck-key').value = '';
      $('key-modal').classList.add('hidden');
      updateLock();
      showToast('🔓 开奖授权成功');
    } catch { showToast('验证失败，请重试'); }
  }
  $('ck-key-ok').onclick = submitKey;
  $('ck-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });
  $('ck-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('ck-key').focus(); });
  $('key-modal').addEventListener('click', (e) => { if (e.target === $('key-modal')) $('key-modal').classList.add('hidden'); });
  $('ck-lock').onclick = openKeyModal;
  // 启动时探测已有会话（12 小时内登录过则免再登）
  CTL.ensureKey();

  function updateDock(s) {
    const rounds = s.rounds || [];
    const curR = rounds.find((r) => r.id === s.current_round_id) || null;
    const pendings = rounds.filter((r) => r.status === 'pending');
    const label = $('ck-round-label');
    const primary = $('ck-primary');

    label.textContent = curR
      ? `${curR.seq}. ${curR.name} · ${curR.prize_name}${curR.status === 'drawn' ? '（已开）' : ''}`
      : pendings.length
        ? `下一场：${pendings[0].seq}. ${pendings[0].name}`
        : '无待开轮次';

    let text = '开始抽奖', disabled = false;
    if (s.phase === 'rolling') {
      text = '🎉 立即揭晓';
    } else if (s.phase === 'ready') {
      if (curR && curR.status === 'pending') text = '🎡 开始滚动';
      else { text = '待选轮次'; disabled = true; }
    } else if (s.phase === 'reveal' && curR && curR.status === 'drawn') {
      text = pendings.length ? `下一轮 → ${pendings[0].name}` : '↩ 返回签到页';
    } else {
      // idle（或异常相位）：选下一待开轮次
      const target = curR && curR.status === 'pending' ? curR : pendings[0];
      if (target) text = `▶ 开始 ${target.name}`;
      else { text = '轮次已全部开完'; disabled = true; }
    }
    primary.textContent = text;
    primary.disabled = disabled || CTL.busy;
    primary.dataset.phase = s.phase;
  }

  async function primaryAction() {
    if (CTL.busy || !cur) return;
    if (!(await CTL.ensureKey())) return;
    const rounds = cur.rounds || [];
    const curR = rounds.find((r) => r.id === cur.current_round_id) || null;
    const pendings = rounds.filter((r) => r.status === 'pending');
    CTL.busy = true;
    $('ck-primary').disabled = true;
    try {
      if (cur.phase === 'rolling' && curR) {
        await CTL.call('POST', `/api/admin/rounds/${curR.id}/draw`);
      } else if (cur.phase === 'ready' && curR && curR.status === 'pending') {
        await CTL.call('POST', '/api/admin/phase', { phase: 'rolling' });
      } else {
        // idle / 揭晓完成：开下一轮或返回签到
        const target = (curR && curR.status === 'pending' && cur.phase !== 'reveal') ? curR : pendings[0];
        if (target) await CTL.call('POST', `/api/admin/rounds/${target.id}/select`);
        else await CTL.call('POST', '/api/admin/phase', { phase: 'idle' });
      }
    } catch (e) {
      showToast('⚠ ' + (e.message || '操作失败'));
    } finally {
      CTL.busy = false;
      if (cur) updateDock(cur);
    }
  }
  $('ck-primary').onclick = primaryAction;
  $('ck-idle').onclick = async () => {
    if (!(await CTL.ensureKey())) return;
    try { await CTL.call('POST', '/api/admin/phase', { phase: 'idle' }); } catch (e) { showToast('⚠ ' + e.message); }
  };
  async function cycleRound(dir) {
    if (!cur || CTL.busy) return;
    const rounds = cur.rounds || [];
    if (!rounds.length) return;
    if (!(await CTL.ensureKey())) return;
    const idx = rounds.findIndex((r) => r.id === cur.current_round_id);
    const nextIdx = (((idx < 0 ? 0 : idx + dir) % rounds.length) + rounds.length) % rounds.length;
    const target = rounds[nextIdx];
    CTL.busy = true;
    try { await CTL.call('POST', `/api/admin/rounds/${target.id}/select`); }
    catch (e) { showToast('⚠ ' + (e.message || '操作失败')); }
    finally { CTL.busy = false; }
  }
  $('ck-prev').onclick = () => cycleRound(-1);
  $('ck-next').onclick = () => cycleRound(1);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' || e.key === 'M') toggleMute();
    if (e.key === 'f' || e.key === 'F') toggleFull();
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (typing) return;
    if (e.key === 'ArrowLeft') cycleRound(-1);
    else if (e.key === 'ArrowRight') cycleRound(1);
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); primaryAction(); }
  });

  // ---------- 3D 头像星球（斐波那契球面 + 透视投影；支持双星球对转与聚光寻人） ----------
  function buildSphere(el, cfg) {
    return {
      el, cfg, pts: [], sig: '',
      rotY: cfg.rot0 || 0,
      speed: cfg.speed0,
      target: cfg.speed0,
      R: 240,
      F: 900, // 透视焦距
      hunt: null, // { mode:'sweep'|'lock', spotAngle, spotSpeed, lockedId }
      update(sample) {
        const sig = sample.map((u) => u.id).join(',');
        if (sig === this.sig) return;
        this.sig = sig;
        this.el.innerHTML = '';
        this.pts = [];
        if (!sample.length) return;
        let list;
        if (sample.length > cfg.count) {
          // 均匀抽样，保持每次重建采样稳定
          const step = sample.length / cfg.count;
          list = Array.from({ length: cfg.count }, (_, i) => sample[Math.floor(i * step)]);
        } else {
          list = sample.slice();
          while (list.length < 12) list = list.concat(list); // 少量用户时补密度
        }
        const n = list.length;
        const golden = Math.PI * (3 - Math.sqrt(5));
        for (let i = 0; i < n; i++) {
          const y = 1 - (i / (n - 1)) * 2;
          const rad = Math.sqrt(Math.max(0, 1 - y * y));
          const theta = golden * i;
          const img = document.createElement('img');
          img.className = 'sp-av';
          img.src = list[i].avatar || defaultAvatar();
          img.alt = '';
          img.onerror = () => { img.onerror = null; img.src = defaultAvatar(); };
          this.el.appendChild(img);
          this.pts.push({ el: img, id: list[i].id, x: Math.cos(theta) * rad, y, z: Math.sin(theta) * rad });
        }
        this.resize();
      },
      resize() {
        this.R = Math.min(window.innerWidth, window.innerHeight) * 0.36 * cfg.radiusFactor;
        const size = Math.max(22, Math.min(96, this.R * cfg.sizeFactor));
        for (const p of this.pts) p.el.style.width = p.el.style.height = size + 'px';
      },
      frame(dt, t) {
        if (!this.pts.length) return;
        this.speed += (this.target - this.speed) * Math.min(1, dt * 1.5);
        this.rotY += this.speed * dt;
        const rolling = $('main-stage').dataset.phase === 'rolling';
        const tilt = cfg.tilt + (rolling ? Math.sin(t / 360 + cfg.phase) * 0.09 : Math.sin(t / 2400 + cfg.phase) * 0.02);
        const cy = Math.cos(this.rotY), sy = Math.sin(this.rotY);
        const cx = Math.cos(tilt), sx = Math.sin(tilt);
        const hunting = !!this.hunt;
        if (hunting) {
          // 聚光扫过：角度随时间加速推进
          this.hunt.spotAngle += this.hunt.spotSpeed * dt;
          this.hunt.spotSpeed = Math.min(7.5, this.hunt.spotSpeed + dt * 3.4);
        }
        for (const p of this.pts) {
          const x1 = p.x * cy + p.z * sy;      // 绕 Y 轴自转
          const z1 = -p.x * sy + p.z * cy;
          const y2 = p.y * cx - z1 * sx;       // 绕 X 轴倾斜
          const z2 = p.y * sx + z1 * cx;
          let s = this.F / (this.F - z2 * this.R); // 前大后小
          let depth = 0.28 + 0.72 * (z2 + 1) / 2;  // 前亮后暗
          let lit = false;
          if (hunting) {
            depth *= 0.16; // 寻人时全场熄灭
            if (this.hunt.mode === 'lock' && p.id === this.hunt.lockedId) {
              lit = true;
              depth = 1; s *= 1.75;
            } else if (this.hunt.mode === 'sweep') {
              // 当前屏幕水平角（与 spotAngle 同空间）
              const a = Math.atan2(x1, z1);
              let d = a - this.hunt.spotAngle;
              d = Math.atan2(Math.sin(d), Math.cos(d)); // 归一化到 [-π, π]
              if (Math.abs(d) < 0.5 && z2 > -0.12) { lit = true; depth = Math.max(depth, 0.95); s *= 1.16; }
            }
          }
          p.el.style.transform =
            `translate(-50%,-50%) translate3d(${(x1 * this.R * s).toFixed(1)}px, ${(y2 * this.R * s).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
          p.el.style.opacity = (depth * cfg.dim).toFixed(2);
          p.el.style.zIndex = Math.round((z2 + 1) * 100) + (lit ? 200 : 0);
          p.el.classList.toggle('lit', lit);
        }
      },
    };
  }

  // 主星球 + 外圈反向慢速小星球环（层次感）
  const sphere = buildSphere($('sphere'), {
    count: 100, radiusFactor: 1, sizeFactor: 0.19, tilt: -0.3, speed0: 0.12, dim: 1, phase: 0,
  });
  const sphere2 = buildSphere($('sphere2'), {
    count: 30, radiusFactor: 1.45, sizeFactor: 0.10, tilt: 0.22, speed0: -0.06, dim: 0.5, phase: 2.1, rot0: 1.7,
  });

  function defaultAvatar() {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='72' height='72' fill='%23a31212'/%3E%3Ccircle cx='36' cy='28' r='12' fill='%23ffd700'/%3E%3Cpath d='M14 62c3-12 12-18 22-18s19 6 22 18z' fill='%23ffd700'/%3E%3C/svg%3E";
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { sphere.resize(); sphere2.resize(); }, 250);
  });

  let lastT = performance.now();
  (function loop(t) {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    starfield.frame(dt, t);
    sphere.frame(dt, t);
    sphere2.frame(dt, t);
    requestAnimationFrame(loop);
  })(lastT);

  // ---------- 中央滚动 ----------
  let rollTimer = null;
  function rollStart(sample) {
    rollStop();
    const img = $('roll-avatar'), name = $('roll-name');
    img.onerror = () => (img.src = defaultAvatar());
    const pool = sample.length ? sample : null;
    const pick = () => {
      const u = pool ? pool[(Math.random() * pool.length) | 0] : null;
      if (u) { img.src = u.avatar || defaultAvatar(); name.textContent = u.nickname; }
      else { img.src = defaultAvatar(); name.textContent = '???'; }
    };
    pick();
    rollTimer = setInterval(pick, 95);
  }
  function rollStop() { clearInterval(rollTimer); rollTimer = null; }

  // ---------- 阶段切换 ----------
  function show(box) {
    for (const id of ['c-qr', 'c-prize', 'c-roll', 'c-reveal']) $(id).classList.toggle('hidden', id !== box);
  }

  /** 揭晓瞬间：全屏闪光 + 震屏 + 镜头急推 */
  function flashAndShake() {
    const flash = $('flash-layer');
    flash.classList.remove('on');
    void flash.offsetWidth; // 重置动画
    flash.classList.add('on');
    const stage = $('stage');
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
    setTimeout(() => stage.classList.remove('shake'), 550);
    const cam = $('main-stage');
    cam.classList.remove('punch');
    void cam.offsetWidth;
    cam.classList.add('punch');
    setTimeout(() => cam.classList.remove('punch'), 750);
  }

  // ---------- 3·2·1 倒计时（滚动开场编排，主持人揭晓可随时打断） ----------
  let phaseToken = 0;
  function playCountdown(done) {
    const box = $('countdown');
    const seq = [
      { n: '3', f: 659 },
      { n: '2', f: 784 },
      { n: '1', f: 988 },
    ];
    box.classList.remove('hidden');
    seq.forEach((it, i) => {
      setTimeout(() => {
        if (!box.classList.contains('hidden')) {
          box.innerHTML = `<span>${it.n}</span>`;
          AudioFX.tone(it.f, 0, 0.42, 'sine', 0.3);
        }
      }, i * 700);
    });
    setTimeout(() => {
      box.classList.add('hidden');
      box.innerHTML = '';
      done();
    }, seq.length * 700 + 120);
  }

  function applyPhase(s) {
    const phase = s.phase;
    const round = s.rounds.find((r) => r.id === s.current_round_id) || null;
    const allWinners = s.winners_by_round[s.current_round_id] || [];
    const valid = allWinners.filter((w) => w.status === 'valid');

    // 阶段切换时终止一切寻人状态（防止星球停留在熄灭/点亮态）
    if (sphere.hunt) {
      sphere.hunt = null;
      sphere.pts.forEach((p) => p.el.classList.remove('lit'));
    }

    $('main-stage').dataset.phase = phase;

    if (phase === 'rolling') {
      show('c-roll');
      $('reveal-board').classList.add('hidden');
      rollStart(s.pool_sample);
      // 编排：先蓄势减速 → 3·2·1 倒计时 → 星球瞬间拉满转速 + 擂鼓
      const my = ++phaseToken;
      sphere.target = 0.85;
      sphere2.target = -0.4;
      playCountdown(() => {
        if (phaseToken !== my) return; // 倒计时期间已切阶段（如直接揭晓）
        sphere.target = 2.9;
        sphere2.target = -1.2;
        AudioFX.drumrollStart();
      });
      return;
    }
    phaseToken++; // 使未完成的倒计时回调失效
    $('countdown').classList.add('hidden');
    rollStop();
    AudioFX.drumrollStop();

    if (phase === 'reveal' && round) {
      sphere.target = 0.5; // 减速余韵
      sphere2.target = -0.24;
      playReveal(round, valid, allWinners, s);
      return;
    }
    if (phase === 'ready' && round) {
      show('c-prize');
      $('reveal-board').classList.add('hidden');
      $('prize-round').textContent = round.name;
      $('prize-name').textContent = round.prize_name;
      const pimg = $('prize-img');
      if (round.prize_image) {
        pimg.src = round.prize_image;
        pimg.onerror = () => pimg.classList.add('hidden');
        pimg.classList.remove('hidden');
      } else pimg.classList.add('hidden');
      $('prize-count').textContent = `名额 ${round.winner_count} 人`;
      $('prize-tip').textContent = '准备开奖…';
      sphere.target = 0.55; // 中速蓄势
      sphere2.target = -0.28;
      return;
    }
    // idle（或 ready 前的间隙）：缓慢流动的签到氛围
    show('c-qr');
    $('reveal-board').classList.add('hidden');
    sphere.target = 0.12;
    sphere2.target = -0.06;
    loadQR();
  }

  function loadQR() {
    const img = $('qr-img');
    if (img.src) return;
    http.get('/api/screen/qr').then(({ data }) => { if (data && data.dataUrl) img.src = data.dataUrl; }).catch(() => {});
  }

  /** 聚光寻人：星球熄灭 → 聚光加速扫过 → 锁定中奖者头像 → 飞出中央卡片 */
  function huntThenReveal(w, i, done) {
    const inSphere = sphere.pts.some((p) => p.id === w.user_id);
    sphere.hunt = { mode: 'sweep', spotAngle: Math.random() * Math.PI * 2, spotSpeed: 1.6, lockedId: null };
    const huntMs = i === 0 ? 1700 : 1150;
    const tickTimer = setInterval(() => AudioFX.tick(), 130);
    setTimeout(() => {
      clearInterval(tickTimer);
      if (!sphere.hunt) return done(); // 阶段被切走
      sphere.hunt = { mode: 'lock', spotAngle: 0, spotSpeed: 0, lockedId: w.user_id };
      AudioFX.tone(1046, 0, 0.35, 'sine', 0.24);
      setTimeout(() => {
        sphere.hunt = null;
        sphere.pts.forEach((p) => p.el.classList.remove('lit'));
        done();
      }, inSphere ? 620 : 200);
    }, huntMs);
  }

  function playReveal(round, valid, all, s) {
    show('c-reveal');
    const center = $('c-reveal');
    center.innerHTML = '';
    if (!valid.length) {
      center.innerHTML = '<div class="prize-label">本轮暂无有效中奖名单</div>';
      showBoard(round, all, s);
      return;
    }

    // 大名额（超过阈值）：集体揭晓——单次扫场 + 大字 + 名单板瀑布点亮，避免逐人寻人拖沓
    const threshold = (cur && cur.group_reveal_threshold) || 5;
    if (valid.length > threshold) {
      sphere.hunt = { mode: 'sweep', spotAngle: Math.random() * Math.PI * 2, spotSpeed: 2.2, lockedId: null };
      const tickTimer = setInterval(() => AudioFX.tick(), 120);
      setTimeout(() => {
        clearInterval(tickTimer);
        if ($('main-stage').dataset.phase !== 'reveal') return;
        sphere.hunt = null;
        sphere.pts.forEach((p) => p.el.classList.remove('lit'));
        center.innerHTML = `
          <div class="reveal-hero group-hero">
            <div class="crown">👑</div>
            <div class="rh-name">本轮 ${valid.length} 位幸运儿</div>
            <div class="rh-prize">🎉 ${escapeHtml(round.prize_name)}</div>
          </div>`;
        flashAndShake();
        confetti.celebrate(3);
        AudioFX.fanfare();
        showBoard(round, all, s, { stagger: true });
      }, 2400);
      return;
    }

    let t = 300;
    valid.forEach((w, i) => {
      setTimeout(() => {
        if ($('main-stage').dataset.phase !== 'reveal') return; // 阶段已切走，放弃后续动画
        huntThenReveal(w, i, () => {
          if ($('main-stage').dataset.phase !== 'reveal') return;
          center.innerHTML = '';
          const d = document.createElement('div');
          d.className = 'reveal-hero';
          d.style.position = 'relative';
          d.innerHTML = `<div class="crown">👑</div><img src="${w.avatar || defaultAvatar()}" onerror="this.src='${defaultAvatar()}'" class="avatar" alt="">
            <div class="rh-name">${escapeHtml(w.nickname || '幸运儿')}</div>
            <div class="rh-prize">🎉 ${escapeHtml(round.prize_name)}</div>`;
          center.appendChild(d);
          const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
          flashAndShake();
          confetti.burst(cx, cy, { count: 110, speed: 13, lift: 7 });
          confetti.burst(cx, cy, { count: 40, speed: 6, lift: 3 });
          AudioFX.ding(i);
        });
      }, t);
      t += (i === 0 ? 1700 : 1150) + 620 + 720; // 寻人 + 锁定 + 卡片展示
    });
    setTimeout(() => {
      if ($('main-stage').dataset.phase !== 'reveal') return;
      showBoard(round, all, s);
      confetti.celebrate(3);
      AudioFX.fanfare();
    }, t + 200);
  }

  function showBoard(round, all, s, { stagger = false } = {}) {
    $('rb-title').textContent = `🎉 ${round.name} · ${round.prize_name}`;
    const grid = $('rb-grid');
    grid.innerHTML = '';
    let idx = 0;
    for (const w of all) {
      const c = document.createElement('div');
      c.className = 'rb-cell' + (w.status === 'voided' ? ' voided' : '');
      if (stagger) {
        c.style.animation = `cell-in 0.4s cubic-bezier(0.2, 1.5, 0.4, 1) both`;
        c.style.animationDelay = `${Math.min(idx * 70, 3500)}ms`;
        idx++;
      }
      c.innerHTML = `<img src="${w.avatar || defaultAvatar()}" onerror="this.src='${defaultAvatar()}'" alt=""><span class="n">${escapeHtml(w.nickname || '幸运儿')}</span>`;
      grid.appendChild(c);
    }
    $('reveal-board').classList.remove('hidden');
  }

  // ---------- 常规信息渲染 ----------
  let lastSignCount = null;
  function tweenNumber(el, to, ms = 650) {
    const from = parseInt(el.textContent.replace(/\D/g, ''), 10) || 0;
    if (from === to) return;
    const t0 = performance.now();
    (function step(t) {
      const k = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * eased);
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  function renderStatic(s) {
    $('act-title').textContent = s.activity.title || '幸运抽奖';
    $('act-subtitle').textContent = s.activity.subtitle || '';
    document.title = (s.activity.title || '幸运抽奖') + ' · 大屏';
    $('stat-signed').textContent = s.sign_count;
    // 奖池人数不对外展示（只开不减的观感问题）；管理台后台仍可见
    if (lastSignCount !== s.sign_count) {
      tweenNumber($('sign-count'), s.sign_count); // 中央翻牌器
      lastSignCount = s.sign_count;
    }
    let won = 0;
    for (const list of Object.values(s.winners_by_round)) {
      won += list.filter((w) => w.status === 'valid').length;
    }
    $('stat-won').textContent = won;

    // 底部滚动条：历轮中奖名单
    const parts = [];
    for (const r of s.rounds) {
      const list = (s.winners_by_round[r.id] || []).filter((w) => w.status === 'valid');
      if (list.length) parts.push(`${r.name}【${r.prize_name}】：${list.map((w) => w.nickname).join('、')}`);
    }
    $('ticker-inner').textContent = parts.length
      ? '🎊 ' + parts.join('　｜　')
      : '静候开奖，祝大家好运连连 🧧';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function onState(s) {
    cur = s;
    renderStatic(s);
    updateDock(s);
    sphere.update(s.pool_sample || []);
    sphere2.update(s.pool_sample || []);
    const list = s.winners_by_round[s.current_round_id] || [];
    const sig = [s.phase, s.current_round_id, list.map((w) => w.id + w.status).join(','), s.pool_count].join('|');
    if (sig !== prevSig) {
      prevSig = sig;
      applyPhase(s);
    }
  }

  // ---------- 长轮询 ----------
  let polling = false;
  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const { status, data } = await http.get(`/api/screen/state?v=${pollV}&wait=25000`, { retries: 1, timeoutMs: 31000 });
      if (status === 200 && data) { pollV = data.v; onState(data); }
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      polling = false;
    }
    setTimeout(poll, 400);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  document.addEventListener('click', () => AudioFX.ensure(), { once: true });

  poll();
})();
