/* 控制台逻辑：读写配置 + 展示连接状态 */

const $ = (id) => document.getElementById(id);
const hint = $('hint');

let state = null;
let demoOn = false;

/* B站登录态检测：用来判断昵称会不会被打码 */
async function checkBiliLogin() {
  const btn = $('checkBili');
  const box = $('biliLoginHint');
  const cookie = $('biliCookie').value.trim();
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const r = await fetch(`/api/bili/login?cookie=${encodeURIComponent(cookie)}`);
    const j = await r.json();
    if (j.loggedIn) {
      box.className = 'login-ok';
      box.innerHTML = `✓ 已登录：<b>${j.uname || j.mid}</b>。昵称和头像可以正常拿到，表情图也会加载。`;
    } else {
      box.className = 'login-no';
      box.innerHTML = `⚠ 未登录${j.error ? `（${j.error}）` : ''}。能收弹幕，但部分昵称会显示成 <code>一***</code>，表情只有文字。建议按下面步骤填 Cookie。`;
    }
  } catch (e) {
    box.className = 'login-no';
    box.textContent = '检测失败：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '检测登录态';
  }
}

$('checkBili')?.addEventListener('click', checkBiliLogin);

function setHint(text, kind = '') {
  hint.textContent = text;
  hint.className = `hint ${kind}`;
}

function fillForm(cfg) {
  $('biliRoom').value = cfg.rooms?.bilibili?.roomId || '';
  $('dyRoom').value = cfg.rooms?.douyin?.roomId || '';
  $('biliCookie').value = cfg.rooms?.bilibili?.cookie || '';
  $('dyCookie').value = cfg.rooms?.douyin?.cookie || '';
  $('dispTitle').value = cfg.display?.title || '';
  $('maxDanmaku').value = cfg.display?.maxDanmaku ?? 80;
  $('maxGifts').value = cfg.display?.maxGifts ?? 6;
  $('fontScale').value = cfg.display?.fontScale ?? 1;
  $('showEnter').checked = !!cfg.display?.showEnter;
  $('showLike').checked = !!cfg.display?.showLike;
  $('mergeGiftCombo').checked = cfg.display?.mergeGiftCombo !== false;
  $('showHeader').checked = cfg.display?.showHeader !== false;
  $('showGifts').checked = cfg.display?.showGifts !== false;
  setRatio(clampRatio(cfg.display?.giftRatio ?? 32));
}

const STATUS_TEXT = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  live: '直播中',
  offline: '未开播',
  reconnecting: '重连中',
  error: '出错',
};

const LABEL = { bilibili: 'B站', douyin: '抖音' };

function renderStatus() {
  const grid = $('statusGrid');
  grid.innerHTML = '';
  for (const id of ['bilibili', 'douyin']) {
    const p = state?.platforms?.[id] || {};
    const item = document.createElement('div');
    item.className = 'status-item';

    const top = document.createElement('div');
    top.className = 'status-top';
    const dot = document.createElement('span');
    const st = p.status || 'idle';
    dot.className = `status-dot ${['connected', 'live'].includes(st) ? 'live' : st}`;
    top.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = LABEL[id];
    top.appendChild(name);
    const stText = document.createElement('span');
    stText.style.cssText = 'color:var(--text-faint);font-weight:400;font-size:11.5px';
    stText.textContent = STATUS_TEXT[st] || st;
    top.appendChild(stText);
    item.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'status-meta';
    const bits = [];
    if (p.roomId) bits.push(`房间 <b>${p.roomId}</b>`);
    if (p.anchor) bits.push(`主播 <b>${p.anchor}</b>`);
    if (p.online) bits.push(`在线 <b>${p.online}</b>`);
    if (p.status === 'connected') {
      bits.push(p.lastMessageAt ? `最后消息 ${agoText(p.lastMessageAt)}` : '尚未收到消息');
    }
    if (p.title) bits.push(p.title);
    if (p.error) bits.push(`<span style="color:#ff8f9f">${p.error}</span>`);
    meta.innerHTML = bits.length ? bits.join(' · ') : '填房间号后自动连接';
    item.appendChild(meta);

    // 收到过哪些消息类型——排查「某类消息为什么没有」最直接
    const methods = p.methods || {};
    const keys = Object.keys(methods).sort((a, b) => methods[b] - methods[a]);
    if (keys.length) {
      const m = document.createElement('div');
      m.className = 'status-methods';
      const shown = keys.slice(0, 8);
      m.innerHTML =
        '收到类型：' +
        shown.map((k) => `<span>${k}<i>×${methods[k]}</i></span>`).join('') +
        (keys.length > shown.length ? `<span>…共 ${keys.length} 种</span>` : '');
      m.title = keys.map((k) => `${k} × ${methods[k]}`).join('\n');
      item.appendChild(m);
    }

    grid.appendChild(item);
  }
}

function agoText(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return `${Math.round(s / 3600)} 小时前`;
}

async function loadState() {
  try {
    const r = await fetch('/api/state');
    const j = await r.json();
    state = j.state;
    renderStatus();
    if (!document.querySelector('#biliRoom').dataset.filled) {
      fillForm(j.config);
      document.querySelector('#biliRoom').dataset.filled = '1';
    }
    $('obsUrl').textContent = `http://127.0.0.1:${location.port || 7801}/?obs=1`;
  } catch (e) {
    setHint('连不上本地服务，确认终端里的 node 还在跑', 'err');
  }
}

function collect() {
  return {
    rooms: {
      bilibili: { roomId: $('biliRoom').value.trim(), cookie: $('biliCookie').value.trim() },
      douyin: { roomId: $('dyRoom').value.trim(), cookie: $('dyCookie').value.trim() },
    },
    display: {
      title: $('dispTitle').value.trim(),
      maxDanmaku: Number($('maxDanmaku').value) || 80,
      maxGifts: Number($('maxGifts').value) || 6,
      fontScale: Number($('fontScale').value) || 1,
      showEnter: $('showEnter').checked,
      showLike: $('showLike').checked,
      mergeGiftCombo: $('mergeGiftCombo').checked,
      giftRatio: clampRatio($('giftRatio').value),
      showGifts: $('showGifts').checked,
      showHeader: $('showHeader').checked,
    },
  };
}

$('save').addEventListener('click', async () => {
  setHint('保存中…');
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(collect()),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    setHint('已保存，正在连接直播间（几秒后看状态）', 'ok');
    setTimeout(loadState, 1200);
  } catch (e) {
    setHint('保存失败：' + e.message, 'err');
  }
});

$('demo').addEventListener('click', async (e) => {
  demoOn = !demoOn;
  e.currentTarget.classList.toggle('on', demoOn);
  e.currentTarget.textContent = demoOn ? '关闭演示模式' : '开启演示模式';
  try {
    await fetch('/api/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: demoOn }),
    });
    setHint(demoOn ? '演示模式已开，打开面板看看效果' : '演示模式已关', 'ok');
  } catch (err) {
    setHint('切换失败：' + err.message, 'err');
  }
});

$('copyObs').addEventListener('click', async () => {
  const url = $('obsUrl').textContent.trim();
  try {
    await navigator.clipboard.writeText(url);
    setHint('已复制 OBS 地址：' + url, 'ok');
  } catch {
    setHint('复制失败，手动复制：' + url, 'err');
  }
});

$('fontScale').addEventListener('input', (e) => {
  $('fontScale').title = e.target.value;
});

loadState();
setInterval(loadState, 3000);

// 面板实时事件
try {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === 'platform') {
      state = state || { platforms: {} };
      state.platforms[d.platform.id] = d.platform;
      renderStatus();
    }
  };
} catch {}


/* ---------------- 布局：比例预览 ---------------- */

const PREVIEW = $('layoutPreview');
const LP_GIFT = $('lpGift');
const RATIO = $('giftRatio');
const RATIO_VAL = $('ratioVal');

function clampRatio(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 32;
  return Math.min(75, Math.max(10, Math.round(n)));
}

/** 同步预览、滑块、数字 */
function setRatio(v, { fromSlider } = {}) {
  const ratio = clampRatio(v);
  if (fromSlider === undefined) RATIO.value = String(ratio);
  RATIO_VAL.textContent = `${ratio}%`;
  LP_GIFT.style.flex = `0 0 ${ratio}%`;
  for (const b of document.querySelectorAll('.preset-row .btn')) {
    b.classList.toggle('active', Number(b.dataset.ratio) === ratio);
  }
  syncPreview();
}

function syncPreview() {
  PREVIEW.classList.toggle('no-gift', !$('showGifts').checked);
}

RATIO?.addEventListener('input', () => setRatio(RATIO.value, { fromSlider: true }));
$('showGifts')?.addEventListener('change', syncPreview);

for (const btn of document.querySelectorAll('.preset-row .btn')) {
  btn.addEventListener('click', () => setRatio(btn.dataset.ratio));
}

// 在预览里直接拖分界线
if (PREVIEW) {
  let dragging = false;
  const applyFromY = (clientY) => {
    const rect = PREVIEW.getBoundingClientRect();
    const ratio = ((clientY - rect.top) / rect.height) * 100;
    setRatio(ratio);
  };
  PREVIEW.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.lp-divider')) return;
    dragging = true;
    PREVIEW.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  PREVIEW.addEventListener('pointermove', (e) => {
    if (dragging) applyFromY(e.clientY);
  });
  PREVIEW.addEventListener('pointerup', (e) => {
    dragging = false;
    try {
      PREVIEW.releasePointerCapture(e.pointerId);
    } catch {}
  });
}

/* ---------------- 扫码登录 ---------------- */

const modal = $('loginModal');
const modalTitle = $('loginTitle');
const modalQr = $('loginQr');
const modalStatus = $('loginStatus');
const modalHint = $('loginHint');
const btnRefresh = $('loginRefresh');

let loginTimer = null;
let loginKind = '';

function setModalStatus(text, kind = '') {
  modalStatus.textContent = text;
  modalStatus.className = `modal-status ${kind}`;
}

function closeLogin({ silent } = {}) {
  if (loginTimer) {
    clearInterval(loginTimer);
    loginTimer = null;
  }
  if (!silent && loginKind === 'douyin') {
    fetch('/api/login/douyin/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(
      () => {},
    );
  }
  loginKind = '';
  modal.hidden = true;
  modalQr.innerHTML = '';
  modalHint.textContent = '';
}

$('loginClose')?.addEventListener('click', () => closeLogin());
$('loginCancel')?.addEventListener('click', () => closeLogin());
modal?.addEventListener('click', (e) => {
  if (e.target === modal) closeLogin();
});

/* ---- B站：服务端出二维码，前端轮询状态 ---- */

async function startBiliLogin() {
  loginKind = 'bilibili';
  modal.hidden = false;
  modalTitle.textContent = 'B站扫码登录';
  modalQr.innerHTML = '';
  btnRefresh.hidden = false;
  btnRefresh.textContent = '刷新二维码';
  modalHint.textContent = '用 B站手机客户端扫上面的码，确认后会自动填入 Cookie（还需要点保存）。';
  setModalStatus('正在生成二维码…');

  const r = await fetch('/api/login/bilibili/start', { method: 'POST' }).then((x) => x.json());
  if (!r.ok) {
    setModalStatus(r.error || '生成失败', 'err');
    return;
  }
  modalQr.innerHTML = r.svg;
  setModalStatus('等待扫码…');

  const key = r.key;
  clearInterval(loginTimer);
  loginTimer = setInterval(async () => {
    if (loginKind !== 'bilibili') return;
    try {
      const s = await fetch(`/api/login/bilibili/poll?key=${encodeURIComponent(key)}`).then((x) => x.json());
      if (s.status === 'scanned') setModalStatus('已扫码，请在手机上确认');
      else if (s.status === 'confirmed') {
        clearInterval(loginTimer);
        $('biliCookie').value = s.cookie;
        setModalStatus('登录成功，Cookie 已填入（记得点下面的保存）', 'ok');
        modalQr.innerHTML = '';
        setTimeout(() => closeLogin({ silent: true }), 1200);
      } else if (s.status === 'expired') {
        clearInterval(loginTimer);
        setModalStatus(s.message || '二维码已过期，请刷新', 'err');
        modalQr.innerHTML = '';
      }
    } catch {
      // 网络抖动，下一轮再说
    }
  }, 2000);
}

/* ---- 抖音：开一个临时浏览器窗口，扫码后读 Cookie ---- */

async function startDouyinLogin() {
  loginKind = 'douyin';
  modal.hidden = false;
  modalTitle.textContent = '抖音扫码登录';
  modalQr.innerHTML = '<p class="modal-hint">即将打开浏览器窗口…</p>';
  btnRefresh.hidden = true;
  modalHint.textContent =
    '抖音的扫码接口有风控，只能借本机浏览器：弹出来的窗口里点「登录」→ 扫码，登录成功后这里会自动填好。';
  setModalStatus('正在启动浏览器…');

  const r = await fetch('/api/login/douyin/start', { method: 'POST' }).then((x) => x.json());
  if (!r.ok) {
    setModalStatus(r.error || '启动失败', 'err');
    modalQr.innerHTML = '';
    return;
  }
  modalQr.innerHTML = '<p class="modal-hint">已打开浏览器窗口，<br/>请在窗口里点「登录」并扫码。</p>';
  setModalStatus('等待扫码…');

  const id = r.id;
  clearInterval(loginTimer);
  loginTimer = setInterval(async () => {
    if (loginKind !== 'douyin') return;
    try {
      const s = await fetch(`/api/login/douyin/poll?id=${encodeURIComponent(id)}`).then((x) => x.json());
      if (s.status === 'confirmed') {
        clearInterval(loginTimer);
        $('dyCookie').value = s.cookie;
        setModalStatus('登录成功，Cookie 已填入（记得点下面的保存）', 'ok');
        modalQr.innerHTML = '';
        setTimeout(() => closeLogin({ silent: true }), 1200);
      } else if (s.status === 'error') {
        clearInterval(loginTimer);
        setModalStatus(s.message || '出错了', 'err');
      }
    } catch {
      // 网络抖动
    }
  }, 2000);
}

$('scanBili')?.addEventListener('click', startBiliLogin);
$('scanDouyin')?.addEventListener('click', startDouyinLogin);
btnRefresh?.addEventListener('click', () => {
  if (loginKind === 'bilibili') startBiliLogin();
});
