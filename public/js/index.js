/* ============ 用户页逻辑：长轮询 + 状态渲染 + 中奖庆祝 + 领奖查询视图 ============ */
(function () {
  let version = 0;
  let lastMyWin = null;
  let polling = false;
  const $ = (id) => document.getElementById(id);

  // 领奖查询模式：?claim=1 进入；授权跳转前记忆，回来后自动恢复
  let CLAIM = new URLSearchParams(location.search).get('claim') === '1';
  if (CLAIM) sessionStorage.setItem('ld_claim', '1');
  else if (sessionStorage.getItem('ld_claim') === '1') CLAIM = true;

  function avatarOnerror(img) {
    img.onerror = null;
    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='72' height='72' rx='14' fill='%23a31212'/%3E%3Ctext x='36' y='40' text-anchor='middle' font-size='34' fill='%23ffd700' font-family='sans-serif'%3E%E5%AE%A2%3C/text%3E%3C/svg%3E";
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 领奖查询视图 ----------
  function enterClaimMode() {
    document.querySelectorAll('.me-card, .rounds-section, #win-banner, #stale-tip').forEach((el) => el.classList.add('hidden'));
    $('claim-view').classList.remove('hidden');
    document.title = '中奖查询';
  }

  function renderClaim(s) {
    const body = $('claim-body');
    if (s.my_win) {
      body.innerHTML = `
        <div class="claim-crown">🏆</div>
        <div class="claim-title">恭喜中奖</div>
        <div class="claim-prize">${escapeHtml(s.my_win.prize_name)}</div>
        <div class="claim-round">${escapeHtml(s.my_win.round_name)} · 中奖</div>
        <div class="claim-code-box">
          <div class="claim-code-label">领奖凭证码</div>
          <div class="claim-code">${escapeHtml(s.my_win.claim_code || '')}</div>
        </div>
        <div class="claim-tip">请向领奖台工作人员出示此页面</div>`;
    } else {
      body.innerHTML = `
        <div class="claim-lose-icon">🌸</div>
        <div class="claim-lose-title">未查询到中奖记录</div>
        <div class="claim-lose-sub">感谢参与，祝您好运连连<br>若刚揭晓，请稍等几秒下拉刷新</div>`;
    }
  }

  // ---------- 常规视图 ----------
  function render(s) {
    version = s.v;
    $('act-title').textContent = s.activity.title || '幸运抽奖';
    $('act-subtitle').textContent = s.activity.subtitle || '';
    document.title = CLAIM ? '中奖查询' : (s.activity.title || '幸运抽奖');

    if (CLAIM) {
      renderClaim(s);
      return;
    }

    if (s.me) {
      const img = $('me-avatar');
      if (s.me.avatar) { img.onerror = () => avatarOnerror(img); img.src = s.me.avatar; }
      $('me-name').textContent = s.me.nickname;
    }

    // 中奖横幅（首次出现时礼花庆祝）
    const banner = $('win-banner');
    if (s.my_win) {
      banner.classList.remove('hidden');
      $('win-prize').textContent = s.my_win.prize_name;
      $('win-round').textContent = `${s.my_win.round_name} · 中奖`;
      if (!lastMyWin) {
        confetti.celebrate(3);
        if (navigator.vibrate) navigator.vibrate([120, 60, 120, 60, 240]);
      }
    } else {
      banner.classList.add('hidden');
    }
    lastMyWin = s.my_win || null;

    $('stale-tip').classList.toggle('hidden', !s.link || !s.link.stale);

    // 轮次进度
    const box = $('rounds-list');
    const hasRounds = (s.rounds || []).length > 0;
    box.innerHTML = '';
    for (const r of s.rounds || []) {
      const el = document.createElement('div');
      const isMine = s.my_win && s.my_win.seq === r.seq;
      el.className = 'round-item' + (isMine ? ' mine' : '');
      let stateHtml, stateCls;
      const isLive = s.phase === 'rolling' && s.current_round_id === r.id;
      if (isMine) { stateHtml = '🎉 我中了'; stateCls = 'won'; }
      else if (r.status === 'drawn') { stateHtml = '已开出'; stateCls = 'done'; }
      else if (isLive) { stateHtml = '抽奖中'; stateCls = 'live'; }
      else { stateHtml = '待开'; stateCls = 'wait'; }
      el.innerHTML = `
        <div class="round-seq">${r.seq}</div>
        ${r.prize_image ? `<img class="round-thumb" src="${escapeHtml(r.prize_image)}" onerror="this.remove()" alt="">` : ''}
        <div class="round-main">
          <div class="round-prize">${escapeHtml(r.prize_name)}</div>
          <div class="round-name">${escapeHtml(r.name)} · 名额 ${r.winner_count}</div>
        </div>
        <div class="round-state ${stateCls}">${stateHtml}</div>`;
      box.appendChild(el);
    }
    if (!hasRounds) box.innerHTML = '<div class="round-item"><div class="round-main" style="text-align:center;color:var(--ink-dim);font-size:13px">静候开奖 · 轮次由现场主持公布</div></div>';
  }

  async function poll() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const { status, data } = await http.get(`/api/me/state?v=${version}&wait=20000`, { retries: 1, timeoutMs: 26000 });
      if (status === 200 && data) render(data);
    } catch (e) {
      if (e.status === 401) { location.replace('/auth/wechat'); return; } // CLAIM 已存 sessionStorage，回来自动恢复
      await new Promise((r) => setTimeout(r, 3000)); // 弱网退避
    } finally {
      polling = false;
    }
    setTimeout(poll, 500);
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  // 签到关闭提示
  if (new URLSearchParams(location.search).get('signin') === 'closed') {
    document.querySelector('.page').innerHTML =
      '<div class="card signin-closed"><div class="big">⏳</div><div style="font-size:18px;font-weight:800">签到通道已关闭</div>' +
      '<div style="margin-top:8px;color:var(--ink-dim);font-size:13px">如需参与请联系现场工作人员</div></div>';
  } else {
    if (CLAIM) enterClaimMode();
    poll();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }
})();
