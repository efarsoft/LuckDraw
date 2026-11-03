/* ============ 管理台逻辑（账号密码会话登录） ============ */
(function () {
  const $ = (id) => document.getElementById(id);
  let ov = null;
  let search = '';

  async function call(method, path, body) {
    const resp = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await resp.json(); } catch { /* empty */ }
    if (!resp.ok) {
      if (resp.status === 401) { showGate(); throw new Error('未登录或会话已过期'); }
      throw new Error((data && data.error) || `HTTP ${resp.status}`);
    }
    return data;
  }

  function showGate() {
    $('gate').classList.remove('hidden');
    $('app').classList.add('hidden');
  }
  function showApp() {
    $('gate').classList.add('hidden');
    $('app').classList.remove('hidden');
  }

  async function tryLogin() {
    const username = $('gate-user').value.trim();
    const password = $('gate-pass').value;
    if (!username || !password) { $('gate-err').textContent = '请输入账号和密码'; return; }
    $('gate-btn').disabled = true;
    try {
      const resp = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || '登录失败');
      $('gate-err').textContent = '';
      $('gate-pass').value = '';
      await boot();
    } catch (e) {
      $('gate-err').textContent = e.message || '登录失败';
    } finally {
      $('gate-btn').disabled = false;
    }
  }
  $('gate-btn').onclick = tryLogin;
  ['gate-user', 'gate-pass'].forEach((id) =>
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); })
  );

  $('btn-logout').onclick = async () => {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    showGate();
  };
  $('btn-pass').onclick = async () => {
    const p = prompt('设置新密码（至少 6 位）：');
    if (!p) return;
    try {
      await call('POST', '/api/admin/password', { newPassword: p });
      showToast('✅ 密码已修改，下次登录生效');
    } catch (e) { showToast('❌ ' + e.message); }
  };

  // ---------- 渲染 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const defaultAv = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%23a31212'/%3E%3Ctext x='24' y='31' text-anchor='middle' font-size='24' fill='%23ffd700' font-family='sans-serif'%3E%3F%3C/text%3E%3C/svg%3E";

  function render(data) {
    ov = data;
    $('role-badge').textContent = data.role;
    $('phase-badge').textContent = data.phase + (data.phase === 'rolling' ? '（滚动中）' : '');
    $('btn-sync-now').classList.toggle('hidden', data.role !== 'local'); // 仅本地节点显示
    // 同步状态
    const pill = $('sync-pill'), txt = $('sync-text');
    if (data.role !== 'local') {
      pill.className = 'sync-pill';
      txt.textContent = '单机模式';
    } else if (data.sync && data.sync.linked) {
      pill.className = 'sync-pill ok';
      txt.textContent = data.sync.dirty ? `云端在线 · 待回传 ${'快照'}` : '云端在线 · 已同步';
    } else {
      pill.className = 'sync-pill bad';
      txt.textContent = `云端离线${data.sync && data.sync.dirty ? ' · 结果排队续传中' : ''}`;
    }
    // 活动设置（仅首次填充，避免打字被覆盖）
    if (!$('inp-title').dataset.hydrated) {
      $('inp-title').value = data.activity.title;
      $('inp-subtitle').value = data.activity.subtitle;
      $('inp-signin').checked = data.activity.sign_in_enabled;
      $('inp-profile').checked = data.activity.profile_form_enabled !== false;
      $('inp-threshold').value = data.activity.group_reveal_threshold || 5;
      $('inp-title').dataset.hydrated = '1';
    }
    $('st-users').textContent = data.stats.users;
    $('st-pool').textContent = data.stats.pool;
    $('st-won').textContent = data.stats.won;

    renderRounds(data);
    renderUsers(data);
  }

  function renderRounds(data) {
    const box = $('rounds-list');
    box.innerHTML = '';
    const winnersByRound = {};
    for (const w of data.winners) (winnersByRound[w.round_id] = winnersByRound[w.round_id] || []).push(w);
    if (!data.rounds.length) {
      box.innerHTML = '<div class="dim" style="padding:20px;text-align:center">还没有轮次，先在下方创建</div>';
      return;
    }
    for (const r of data.rounds) {
      const card = document.createElement('div');
      card.className = 'round-card' + (r.id === data.current_round_id ? ' current' : '');
      const ws = winnersByRound[r.id] || [];
      const chips = ws
        .map(
          (w) => `<span class="winner-chip ${w.status === 'voided' ? 'voided' : ''}" title="凭证码 ${w.claim_code || ''}">
            <img src="${w.avatar || defaultAv}" onerror="this.src='${defaultAv}'">
            ${esc(w.nickname)}${w.note ? `<i class="dim">(${esc(w.note)})</i>` : ''}
            <i class="dim">${w.claim_code || ''}</i>
            ${w.status === 'valid' ? `<button data-void="${w.id}" title="弃奖（人出局，可补抽）">✕弃奖</button>` : ''}
          </span>`
        )
        .join('');
      card.innerHTML = `
        <div class="rc-head">
          <span class="rc-name">${r.seq}. ${esc(r.name)}</span>
          <span class="rc-prize">🎁 ${esc(r.prize_name)}</span>
          ${r.prize_image ? `<img class="rc-prize-img" src="${esc(r.prize_image)}" onerror="this.remove()" title="${esc(r.prize_name)}">` : ''}
          <span class="rc-meta">名额 ${r.winner_count} · ${r.status === 'drawn' ? '已开出 ' + ws.filter(w => w.status === 'valid').length + ' 人' : '待抽'}</span>
          <span class="rc-actions">
            ${r.id === data.current_round_id ? '<span class="badge gold">大屏当前</span>' : ''}
            <button class="btn ghost small" data-edit="${r.id}">✏️编辑</button>
            ${r.status === 'drawn' ? `<button class="btn ghost small" data-redraw="${r.id}" title="补齐有效名额">➕补抽</button>` : ''}
            ${r.status === 'drawn' ? `<button class="btn ghost small" data-rollback="${r.id}" title="整轮作废重抽">↩回滚</button>` : ''}
            <button class="btn danger small" data-del="${r.id}">删</button>
          </span>
        </div>
        ${chips ? `<div class="rc-winners">${chips}</div>` : ''}`;
      box.appendChild(card);
    }
  }

  function renderUsers(data) {
    const box = $('users-list');
    const wonSet = new Set(data.winners.filter((w) => w.status === 'valid').map((w) => w.user_id));
    // 注意：overview 未返回全部用户，这里展示 winners + 最近操作提示；
    // 参与名单完整列表走专用接口
    box.innerHTML = '';
    if (!data._users) {
      box.innerHTML = '<div class="dim" style="padding:8px 4px">参与名单加载中…</div>';
      loadUsers();
      return;
    }
    const list = data._users.filter(
      (u) => !search || u.nickname.toLowerCase().includes(search.toLowerCase()) || (u.note || '').includes(search)
    );
    $('users-count').textContent = `${list.length}/${data._users.length} 人`;
    for (const u of list.slice(0, 400)) {
      const row = document.createElement('div');
      row.className = 'user-row' + (u.blocked ? ' blocked' : '');
      const srcName = { wechat: '微信', mock: '模拟', manual: '补录', seed: '种子' }[u.source] || u.source;
      row.innerHTML = `
        <img src="${u.avatar ? '/avatars/' + u.avatar : defaultAv}" onerror="this.src='${defaultAv}'">
        <span>${esc(u.nickname)}</span>
        <span class="src">${srcName}</span>
        ${u.in_pool === 0 ? '<span class="badge gray">仅入场</span>' : ''}
        ${u.phone ? `<span class="note">📱${esc(u.phone)}</span>` : ''}
        ${u.dept ? `<span class="note">${esc(u.dept)}</span>` : ''}
        ${!u.phone && u.note ? `<span class="note">${esc(u.note)}</span>` : ''}
        ${wonSet.has(u.id) ? '<span class="u-won">🏆已中奖</span>' : ''}
        <span class="ops">
          <button class="btn ghost small" data-block="${u.id}" data-val="${u.blocked ? 0 : 1}">${u.blocked ? '恢复' : '排除'}</button>
        </span>`;
      box.appendChild(row);
    }
    if (!list.length) box.innerHTML = '<div class="dim" style="padding:8px 4px">（空）</div>';
  }

  let usersCache = null;
  async function loadUsers() {
    try {
      const data = await call('GET', '/api/admin/users?limit=400');
      usersCache = data.users || [];
      if (ov) { ov._users = usersCache; renderUsers(ov); }
    } catch { /* 忽略 */ }
  }

  // ---------- 轮询 ----------
  let polling = false;
  async function refreshOnce() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const data = await call('GET', '/api/admin/overview');
      data._users = usersCache;
      render(data);
    } catch (e) {
      if (e.message !== '密钥错误') http.setOnline(false);
    } finally {
      polling = false;
    }
  }
  let loopStarted = false;
  function refreshLoop() {
    if (loopStarted) return; // 防止重复登录后叠加定时器
    loopStarted = true;
    refreshOnce();
    setInterval(refreshOnce, 2000);
    setInterval(loadUsers, 15000);
  }

  // ---------- 事件 ----------
  async function act(fn, okMsg) {
    try {
      await fn();
      if (okMsg) showToast(okMsg);
      http.setOnline(true);
      refreshOnce();
    } catch (e) {
      showToast('❌ ' + (e.message || '操作失败'));
    }
  }

  $('app').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const redraw = t.dataset.redraw, rollback = t.dataset.rollback, del = t.dataset.del,
      voidId = t.dataset.void, edit = t.dataset.edit, block = t.dataset.block;
    if (edit) openEdit(edit);
    if (redraw) act(() => call('POST', `/api/admin/rounds/${redraw}/redraw`), '已补抽');
    if (rollback) {
      if (confirm('整轮回滚：该轮中奖全部作废、名额释放回奖池，确定？'))
        act(() => call('POST', `/api/admin/rounds/${rollback}/rollback`), '已回滚');
    }
    if (del) {
      if (confirm('删除该轮次（及其中奖记录），确定？')) act(() => call('DELETE', `/api/admin/rounds/${del}`), '已删除');
    }
    if (voidId) {
      if (confirm('弃奖：该人出局、名额可补抽，确定？')) act(() => call('POST', `/api/admin/winners/${voidId}/void`), '已弃奖');
    }
    if (block !== undefined && block !== null && t.dataset.val !== undefined) {
      act(() => call('POST', `/api/admin/users/${block}/block`, { blocked: t.dataset.val === '1' }));
    }
  });

  $('btn-save-activity').onclick = () =>
    act(
      () =>
        call('PUT', '/api/admin/activity', {
          title: $('inp-title').value.trim(),
          subtitle: $('inp-subtitle').value.trim(),
          sign_in_enabled: $('inp-signin').checked,
          profile_form_enabled: $('inp-profile').checked,
          group_reveal_threshold: parseInt($('inp-threshold').value, 10) || 5,
        }),
      '已保存'
    );

  $('btn-new-round').onclick = () =>
    act(
      async () => {
        await call('POST', '/api/admin/rounds', {
          seq: $('nr-seq').value ? parseInt($('nr-seq').value, 10) : undefined,
          name: $('nr-name').value.trim() || undefined,
          prize_name: $('nr-prize').value.trim() || undefined,
          prize_image: newRoundImgUrl || undefined,
          winner_count: parseInt($('nr-count').value, 10) || 3,
        });
        $('nr-name').value = ''; $('nr-prize').value = ''; $('nr-seq').value = '';
        $('nr-img').value = ''; newRoundImgUrl = '';
        $('nr-img-preview').classList.add('hidden');
      },
      '轮次已创建'
    );

  // ---- 奖品图片上传（base64 → /uploads URL） ----
  function bindPrizeUpload(fileId, previewId, onUrl) {
    $(fileId).addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (f.size > 1.5 * 1024 * 1024) { showToast('图片不能超过 1.5MB'); e.target.value = ''; return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const r = await call('POST', '/api/admin/upload/prize', { dataUrl: reader.result });
          const prev = $(previewId);
          prev.src = r.url;
          prev.classList.remove('hidden');
          prev.onerror = () => prev.classList.add('hidden');
          onUrl(r.url);
          showToast('图片已上传');
        } catch (err) {
          showToast('上传失败: ' + (err.message || ''));
        }
      };
      reader.readAsDataURL(f);
    });
  }
  let newRoundImgUrl = '';
  bindPrizeUpload('nr-img', 'nr-img-preview', (url) => (newRoundImgUrl = url));

  // ---- 编辑轮次弹层 ----
  let editRoundId = null;
  let editImgUrl = null;
  let editImgCleared = false;
  function openEdit(roundId) {
    const r = ov && ov.rounds.find((x) => x.id === parseInt(roundId, 10));
    if (!r) return;
    editRoundId = r.id;
    editImgUrl = r.prize_image || null;
    editImgCleared = false;
    $('er-seq').value = r.seq;
    $('er-name').value = r.name;
    $('er-prize').value = r.prize_name;
    $('er-count').value = r.winner_count;
    const prev = $('er-img-preview');
    if (r.prize_image) { prev.src = r.prize_image; prev.classList.remove('hidden'); prev.onerror = () => prev.classList.add('hidden'); }
    else prev.classList.add('hidden');
    $('er-img').value = '';
    $('edit-modal').classList.remove('hidden');
  }
  bindPrizeUpload('er-img', 'er-img-preview', (url) => { editImgUrl = url; editImgCleared = false; });
  $('er-clear-img').onclick = () => {
    editImgUrl = null; editImgCleared = true;
    $('er-img-preview').classList.add('hidden');
    $('er-img').value = '';
  };
  $('er-cancel').onclick = () => $('edit-modal').classList.add('hidden');
  $('er-save').onclick = () => {
    if (!editRoundId) return;
    act(
      async () => {
        await call('PUT', `/api/admin/rounds/${editRoundId}`, {
          seq: parseInt($('er-seq').value, 10) || 1,
          name: $('er-name').value.trim(),
          prize_name: $('er-prize').value.trim(),
          winner_count: parseInt($('er-count').value, 10) || 1,
          ...(editImgCleared ? { prize_image: null } : editImgUrl ? { prize_image: editImgUrl } : {}),
        });
        $('edit-modal').classList.add('hidden');
      },
      '轮次已保存'
    );
  };

  // 开奖控制已移至大屏页（screen.html），管理台仅保留记录修正类操作（弃奖/补抽/回滚）

  $('btn-manual').onclick = () => {
    const name = $('mu-name').value.trim();
    if (!name) return showToast('请输入姓名');
    act(async () => {
      await call('POST', '/api/admin/users/manual', { name, note: $('mu-note').value.trim() || null });
      $('mu-name').value = ''; $('mu-note').value = '';
    }, '已加入奖池');
  };

  $('btn-import').onclick = () => {
    const text = $('import-text').value;
    if (!text.trim()) return showToast('名单为空');
    act(async () => {
      const r = await call('POST', '/api/admin/users/import', { text });
      $('import-text').value = '';
      showToast(`导入成功 ${r.added} 人${r.errors.length ? `，失败 ${r.errors.length}` : ''}`);
      loadUsers();
    });
  };

  $('user-search').addEventListener('input', (e) => {
    search = e.target.value.trim();
    if (ov) renderUsers(ov);
  });

  // 手动「立即同步」：强制拉取 + 回传，结果即时反馈
  $('btn-sync-now').onclick = async () => {
    const btn = $('btn-sync-now');
    btn.disabled = true;
    btn.textContent = '⟳ 同步中…';
    try {
      const resp = await fetch('/api/admin/sync-now', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const data = await resp.json();
      if (!resp.ok || data.ok === false) {
        showToast('⚠ ' + (data.error || '同步失败'), 3200);
      } else if (data.status && data.status.linked) {
        showToast(`✅ 已同步：新拉取 ${data.pulled_new_users} 人${data.pushed_snapshot ? ' · 结果已回传' : ''}`, 3200);
      } else {
        showToast(`⚠ 云端不可达：${(data.status && data.status.last_error) || '连接失败'}（自动重试中）`, 3600);
      }
    } catch (e) {
      showToast('⚠ 请求失败：' + (e.message || ''));
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ 立即同步';
      refreshOnce();
    }
  };

  $('btn-export').onclick = () => {
    const a = document.createElement('a');
    a.href = '/api/admin/export';
    a.download = 'winners.csv';
    a.click();
  };

  $('btn-export-users').onclick = () => {
    const a = document.createElement('a');
    a.href = '/api/admin/export/users';
    a.download = 'users.csv';
    a.click();
  };

  $('btn-qr').onclick = () => openQrModal('draw');
  $('btn-claim-qr').onclick = () => openQrModal('claim');
  $('btn-entry-qr').onclick = () => openQrModal('entry');
  async function openQrModal(kind) {
    const qs = kind === 'claim' ? '?claim=1' : kind === 'entry' ? '?entry=1' : '';
    try {
      const data = await call('GET', '/api/admin/qrcode' + qs);
      const titles = {
        draw: '🎁 抽奖入口二维码',
        claim: '🎫 领奖查询二维码',
        entry: '🚪 入场签到二维码',
      };
      const tips = {
        draw: '大屏展示用（大屏会自动显示）。用户扫码 → 微信授权 → 进奖池参与抽奖',
        claim: '打印张贴在领奖台：用户扫码即见是否中奖，中奖者显示领奖凭证码，与本页名单核对后发奖',
        entry: '打印张贴在会场入口：用户扫码登记姓名/手机号（不进奖池）。之后扫大屏抽奖码，资料自动带出',
      };
      $('qr-modal-title').textContent = titles[kind];
      $('qr-modal-tip').textContent = tips[kind];
      $('qr-img').src = data.dataUrl;
      $('qr-url').textContent = data.url;
      $('qr-modal').classList.remove('hidden');
    } catch (e) {
      showToast('二维码获取失败');
    }
  }

  $('btn-reset-winners').onclick = () => {
    if (confirm('清空全部中奖记录（签到保留、轮次回到待抽）？')) act(() => call('POST', '/api/admin/reset', { scope: 'winners' }), '已清空中奖');
  };
  $('btn-reset-all').onclick = () => {
    if (confirm('⚠ 清空全部数据（签到+轮次+中奖，不可恢复）？')) {
      if (confirm('再次确认：真的要清空全部数据？')) act(() => call('POST', '/api/admin/reset', { scope: 'all' }), '已全部清空');
    }
  };

  // ---------- 启动 ----------
  async function boot() {
    try {
      const me = await fetch('/api/admin/me', { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (!me) return showGate();
      $('admin-username').textContent = '👤 ' + me.username;
      await call('GET', '/api/admin/overview');
      showApp();
      refreshLoop();
    } catch {
      showGate();
    }
  }
  boot();
})();
