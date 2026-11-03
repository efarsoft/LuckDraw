/* ============ 统一 HTTP 封装：超时 + 指数退避重试 + 离线提示 ============ */
(function () {
  let netBar = null;
  function ensureBar() {
    if (netBar) return;
    netBar = document.createElement('div');
    netBar.id = 'net-bar';
    netBar.textContent = '⚠ 网络不稳定，正在自动重试…';
    document.body.appendChild(netBar);
  }
  function setOnline(ok) {
    ensureBar();
    netBar.classList.toggle('show', !ok);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function request(method, url, body, opts = {}) {
    const timeoutMs = opts.timeoutMs || 15000;
    const retries = opts.retries !== undefined ? opts.retries : 2;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, {
          method,
          signal: ctrl.signal,
          cache: 'no-store',
          credentials: 'same-origin',
          headers: Object.assign(
            {},
            body !== undefined ? { 'content-type': 'application/json' } : {},
            opts.headers || {}
          ),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        clearTimeout(timer);
        if (resp.status === 204) { setOnline(true); return { status: 204, data: null }; }
        let data = null;
        try { data = await resp.json(); } catch { /* 空体 */ }
        if (!resp.ok) {
          const err = new Error((data && data.error) || `HTTP ${resp.status}`);
          err.status = resp.status;
          if (resp.status >= 500 && attempt < retries) { lastErr = err; await sleep(600 * (attempt + 1)); continue; }
          setOnline(true); // 服务可达，属业务错误而非断网
          throw err;
        }
        setOnline(true);
        return { status: resp.status, data };
      } catch (e) {
        clearTimeout(timer);
        const isNet = e.name === 'AbortError' || e instanceof TypeError;
        if (isNet && attempt < retries) {
          lastErr = e;
          setOnline(false);
          await sleep(Math.min(5000, 800 * (attempt + 1)));
          continue;
        }
        if (isNet) setOnline(false);
        throw isNet ? (lastErr || e) : e;
      }
    }
    throw lastErr || new Error('请求失败');
  }

  window.http = {
    get: (url, opts) => request('GET', url, undefined, opts),
    post: (url, body, opts) => request('POST', url, body, opts),
    put: (url, body, opts) => request('PUT', url, body, opts),
    del: (url, opts) => request('DELETE', url, undefined, opts),
    setOnline,
  };
  window.showToast = function (msg, ms = 2600) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), ms);
  };
})();
