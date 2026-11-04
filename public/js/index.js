/* ============ 用户页逻辑：长轮询 + 状态渲染 + 中奖庆祝 + 领奖查询视图 ============ */
(function () {
  let version = 0;
  let lastMyWin = null;
  let polling = false;
  let enteringPool = false;
  const $ = (id) => document.getElementById(id);

  // 领奖查询模式：/claim 或 ?claim=1 进入；授权跳转前记忆，回来后自动恢复
  let CLAIM = location.pathname === '/claim' || new URLSearchParams(location.search).get('claim') === '1';
  if (CLAIM) sessionStorage.setItem('ld_claim', '1');
  else if (sessionStorage.getItem('ld_claim') === '1') CLAIM = true;

  // 入场跳转标记：入场页填完跳过来时暂不入池，等用户主动扫抽奖码
  let FROM_ENTRY = new URLSearchParams(location.search).get('from') === 'entry';
  if (FROM_ENTRY) sessionStorage.setItem('ld_from_entry', '1');

  function avatarOnerror(img) {
    img.onerror = null;
    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='72' height='72' rx='14' fill='%23a31212'/%3E%3Ctext x='36' y='40' text-anchor='middle' font-size='34' fill='%23ffd700' font-family='sans-serif'%3E%E5%AE%A2%3C/text%3E%3C/svg%3E";
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 未入池提示横幅（含伴手礼） ----------
  function showNotInPoolBanner() {
    let el = document.getElementById('pool-tip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pool-tip';
      el.style.cssText = 'margin-top:12px;padding:16px;border-radius:16px;background:rgba(0,0,0,.22);border:1.5px dashed rgba(255,215,0,.5);line-height:1.8;text-align:center';
      const gift = document.getElementById('gift-banner');
      const meCard = document.querySelector('.me-card');
      // 插到"我的卡片"之后、伴手礼之前（伴手礼移进来）
      if (meCard && meCard.nextSibling) meCard.parentNode.insertBefore(el, meCard.nextSibling);
      else document.querySelector('.page').appendChild(el);
      // 把伴手礼横幅搬进来（在未参与提示上方）
      if (gift) el.appendChild(gift);
    }
    el.innerHTML = `
      <div style="font-size:15px;font-weight:900;color:var(--gold-1)">⏳ 未参与抽奖</div>
      <div style="font-size:13px;color:var(--ink-dim);margin-top:4px">
        抽奖环节请扫描<b style="color:var(--gold-2)">大屏幕上的二维码</b>参与<br>
        已登记资料将自动带出，无需重复填写
      </div>`;
    // 伴手礼嵌入（有配置时追加在提示下方）
    const giftNote = window._lastGiftNote;
    if (giftNote) {
      el.innerHTML += `
        <div style="margin-top:10px;padding:10px 14px;border-radius:12px;border:1px dashed rgba(255,215,0,.35);background:rgba(255,215,0,.08);font-size:12.5px;color:var(--gold-1)">
          🎁 ${giftNote}
        </div>`;
    }
    el.classList.remove('hidden');
    // 状态卡片文字也更新
    const status = document.querySelector('.me-status');
    if (status) status.innerHTML = '⏳ 已入场 · 未参与抽奖';
  }
  function hideNotInPoolBanner() {
    const el = document.getElementById('pool-tip');
    if (el) el.classList.add('hidden');
    const status = document.querySelector('.me-status');
    if (status) status.innerHTML = '<span class="dot"></span>已进入奖池 · 坐等好运';
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
    // 资料未完善（且要求填写）→ 跳资料页
    if (s.profile_required && !s.profile_complete && !CLAIM) {
      location.replace('/profile');
      return;
    }
    // 抽奖入口：入场用户（未入池）打开即自动入池；领奖查询视图不触发
    // 入场跳转过来的（from=entry）暂不入池，等扫抽奖码再触发
    if (FROM_ENTRY && s.in_pool === false) {
      sessionStorage.removeItem('ld_from_entry'); // 只跳转当次不池，后续正常访问即入池
      FROM_ENTRY = false;
      showNotInPoolBanner();
    } else if (!s.in_pool && !CLAIM && !enteringPool) {
      enteringPool = true;
      http.post('/api/me/enter-pool', undefined, { retries: 2 }).catch(() => {}).finally(() => {
        enteringPool = false;
      });
    }
    $('act-title').textContent = s.activity.title || '幸运抽奖';
    $('act-subtitle').textContent = s.activity.subtitle || '';
    document.title = CLAIM ? '中奖查询' : (s.activity.title || '幸运抽奖');

    if (CLAIM) {
      renderClaim(s);
      return;
    }

    // 入场用户（未入池）→ 显示"未参与"提示而非自动入池
    if (!s.in_pool) {
      showNotInPoolBanner();
    } else {
      hideNotInPoolBanner();
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

    // 伴手礼提示：配置为空隐藏；未入池时嵌入提示横幅内，已入池时独立显示
    window._lastGiftNote = s.gift_note || '';
    const gb = $('gift-banner');
    if (s.gift_note && !CLAIM && s.in_pool) {
      $('gift-note-text').textContent = s.gift_note;
      gb.classList.remove('hidden');
    } else gb.classList.add('hidden');

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
