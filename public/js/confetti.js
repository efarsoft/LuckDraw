/* ============ Canvas 礼花（零依赖，大屏/手机共用；含流星拖尾与闪光粒） ============ */
(function () {
  const COLORS = ['#ffd700', '#ffb300', '#ff5e5e', '#fff3c4', '#ff9f43', '#ffe066', '#ff6b81', '#ffffff', '#7CFC98'];
  let canvas, ctx, particles = [], running = false, dpr = Math.min(window.devicePixelRatio || 1, 2);

  function ensure() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'confetti-canvas';
    Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '900' });
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }
  function resize() {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(x, y, opts = {}) {
    const n = opts.count || 60;
    for (let i = 0; i < n; i++) {
      const angle = (opts.spread !== undefined ? opts.spread : Math.PI * 2) * Math.random() + (opts.angle || 0);
      const speed = (opts.speed || 9) * (0.35 + Math.random() * 0.9);
      const roll = Math.random();
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (opts.lift !== undefined ? opts.lift : 4),
        w: 6 + Math.random() * 7,
        h: 8 + Math.random() * 10,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.32,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        life: 0,
        ttl: 130 + Math.random() * 90,
        // 形状：纸片 / 圆点 / 流星(拖尾) / 闪光十字
        shape: opts.comet && roll < 0.3 ? 'comet' : roll < 0.4 ? 'spark' : roll < 0.62 ? 'circle' : 'rect',
        wobble: Math.random() * Math.PI * 2,
        grav: 0.14 + Math.random() * 0.08,
      });
    }
    if (!running) { running = true; requestAnimationFrame(tick); }
  }

  function tick() {
    if (!ctx) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    particles = particles.filter((p) => p.life < p.ttl && p.y < window.innerHeight + 60);
    for (const p of particles) {
      p.life++;
      p.vy += p.grav;                 // 重力
      p.vx *= 0.985; p.vy *= 0.985;   // 空气阻力
      p.wobble += 0.1;
      p.x += p.vx + Math.sin(p.wobble) * 0.7;
      p.y += p.vy;
      p.rot += p.vr;
      const alpha = 1 - Math.pow(p.life / p.ttl, 2.2);
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill();
      } else if (p.shape === 'comet') {
        // 流星：运动反方向拖尾（渐隐长条）
        const len = Math.min(46, Math.hypot(p.vx, p.vy) * 2.6);
        const ang = Math.atan2(p.vy, p.vx);
        ctx.rotate(ang - p.rot);
        const grad = ctx.createLinearGradient(0, 0, -len, 0);
        grad.addColorStop(0, p.color);
        grad.addColorStop(1, 'rgba(255,215,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(-len, -1.6, len, 3.2);
        ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, Math.PI * 2); ctx.fill();
      } else if (p.shape === 'spark') {
        // 闪光十字
        const s = p.w * 0.9 * (0.6 + 0.4 * Math.sin(p.life * 0.35));
        ctx.fillRect(-s, -1.2, s * 2, 2.4);
        ctx.fillRect(-1.2, -s, 2.4, s * 2);
      } else {
        // 纸片翻面
        const squash = Math.sin(p.life * 0.12 + p.wobble);
        ctx.fillRect(-p.w / 2, -p.h / 2 * Math.abs(squash || 0.2), p.w, p.h * Math.abs(squash || 0.2) + 1);
      }
      ctx.restore();
    }
    if (particles.length) requestAnimationFrame(tick);
    else { running = false; ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
  }

  window.confetti = {
    /** 定点爆发 */
    burst(x, y, opts) { ensure(); spawn(x, y, Object.assign({ comet: true }, opts)); },
    /** 全屏庆祝：多点连发 + 两侧斜射 */
    celebrate(times = 3) {
      ensure();
      const w = window.innerWidth, h = window.innerHeight;
      for (let i = 0; i < times; i++) {
        setTimeout(() => {
          spawn(w * (0.2 + Math.random() * 0.6), h * 0.55, { count: 85, speed: 12, lift: 7, comet: true });
          spawn(w * (0.15 + Math.random() * 0.7), h * 0.3, { count: 50, speed: 9, lift: 5 });
          // 两侧底部斜向喷射（加农炮效果）
          spawn(w * 0.06, h * 0.92, { count: 40, speed: 15, lift: 10, spread: 0.9, angle: -Math.PI / 3, comet: true });
          spawn(w * 0.94, h * 0.92, { count: 40, speed: 15, lift: 10, spread: 0.9, angle: -Math.PI * 2 / 3, comet: true });
        }, i * 650);
      }
    },
    /** 顶部持续飘落 */
    rain(durationMs = 4000) {
      ensure();
      const w = window.innerWidth;
      const t = setInterval(() => spawn(Math.random() * w, -20, { count: 9, speed: 2, lift: -2 }), 150);
      setTimeout(() => clearInterval(t), durationMs);
    },
  };
})();
