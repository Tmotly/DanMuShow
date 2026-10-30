/* 展示端：吃服务端推来的归一化消息，渲染成「上礼物 / 下弹幕」的矩形面板 */

const params = new URLSearchParams(location.search);
const OBS = params.has('obs');
// obs 默认不显示头部；想连头部（含在线观众条）一起叠加就加 head=1
const NO_HEAD = params.has('nohead') || (OBS && !params.has('head'));
// obs 默认纯透明底；想回到深色卡片就加 bg=1
const KEEP_BG = OBS && params.has('bg');
const SCALE = Number(params.get('scale') || 1);
const PANEL_W = params.get('w');
const PANEL_H = params.get('h');

if (OBS) {
  document.body.classList.add('obs');
  // OBS 的透明底要求 html 和 body 都不刷底色，这里直接写死 inline 样式最稳
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
}
if (KEEP_BG) document.body.classList.add('keep-bg');
if (NO_HEAD) document.body.classList.add('no-head');

const panel = document.getElementById('panel');
if (PANEL_W) panel.style.width = /^\d+$/.test(PANEL_W) ? `${PANEL_W}px` : PANEL_W;
if (PANEL_H) panel.style.height = /^\d+$/.test(PANEL_H) ? `${PANEL_H}px` : PANEL_H;
if (SCALE && SCALE !== 1) document.documentElement.style.setProperty('--font-scale', String(SCALE));

const el = {
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  platforms: document.getElementById('platforms'),
  onlineBar: document.getElementById('onlineBar'),
  onlineTotal: document.getElementById('onlineTotal'),
  onlineSplit: document.getElementById('onlineSplit'),
  giftStream: document.getElementById('giftStream'),
  chatStream: document.getElementById('chatStream'),
  giftCount: document.getElementById('giftCount'),
  chatCount: document.getElementById('chatCount'),
};

const PLATFORM_LABEL = { bilibili: 'B站', douyin: '抖音' };
const PLATFORM_FULL = { bilibili: '哔哩哔哩', douyin: '抖音' };

let cfg = {
  display: { maxDanmaku: 200, maxGifts: 30, showEnter: false, showLike: false, showHeader: true, fontScale: 1 },
  rooms: {},
};
let platformState = { bilibili: {}, douyin: {} };
let emojiMaps = { bilibili: {}, douyin: {} };
let chatCount = 0;
let giftCount = 0;
const giftIndex = new Map(); // giftKey -> { node, at }

/* ---------------- 小工具 ---------------- */

const assetProxy = (url) => (url ? `/api/avatar?u=${encodeURIComponent(url)}` : '');

function initial(name) {
  const s = String(name || '?').trim();
  return s ? [...s][0].toUpperCase() : '?';
}

function hashColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 42% 32%)`;
}

/** 1.2万 这种紧凑写法 */
function compactNum(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(v);
}

function formatYuan(gift, platform) {
  if (!gift) return '';
  const count = gift.count || 1;
  const unit = Number(gift.unitPrice || 0);
  if (!unit) return '';
  let yuan;
  if (platform === 'bilibili') {
    if (gift.coinType === 'silver') return '';
    yuan = (unit * count) / 1000; // B站金瓜子 1000 = 1 元
  } else {
    yuan = (unit * count) / 10; // 抖音 10 钻 ≈ 1 元
  }
  if (!Number.isFinite(yuan) || yuan <= 0) return '';
  const shown = yuan >= 100 ? Math.round(yuan) : yuan >= 10 ? yuan.toFixed(0) : yuan.toFixed(1).replace(/\.0$/, '');
  return `¥${shown}`;
}

const GIFT_EMOJI = ['🎁', '💝', '🌸', '⚡', '🍬', '🎈', '💎', '🔥'];
function giftEmoji(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 17 + ch.codePointAt(0)) % 997;
  return GIFT_EMOJI[h % GIFT_EMOJI.length];
}

function shouldShow(msg) {
  switch (msg.kind) {
    case 'chat':
    case 'gift':
    case 'superchat':
      return true;
    case 'enter':
      return !!cfg.display.showEnter;
    case 'like':
    case 'follow':
      return !!cfg.display.showLike;
    default:
      return false;
  }
}

/* ---------------- 富文本：表情图 / 表情胶囊 ---------------- */

const EMOJI_TOKEN = /(\[[^\[\]\s]{1,12}\])/;

function makeEmojiImg(url) {
  const img = document.createElement('img');
  img.className = 'dm-emoji';
  img.src = assetProxy(url);
  img.alt = '';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.onerror = () => {
    const span = document.createElement('span');
    span.className = 'emoji-chip';
    span.textContent = '[表情]';
    img.replaceWith(span);
  };
  return img;
}

/**
 * 把弹幕内容渲染到节点上：
 * - msg.emoji 有图 → 直接画大表情（B站大表情弹幕的内容就是表情名，不必再重复文字）
 * - 文本里的 [花] 这种 → 有表情映射就换图，没有就画成胶囊，至少不是一串方括号
 */
function renderRichText(container, msg) {
  if (msg.emoji?.url) {
    container.appendChild(makeEmojiImg(msg.emoji.url));
    return;
  }

  const text = String(msg.text ?? '');
  if (!text) return;
  const map = emojiMaps[msg.platform] || {};

  for (const part of text.split(EMOJI_TOKEN)) {
    if (!part) continue;
    const m = /^\[([^\[\]\s]{1,12})\]$/.exec(part);
    if (m) {
      // 服务端下发的 key 是去掉括号的名字；这里两种写法都兼容
      const url = map[m[1]] || map[part] || '';
      if (url) {
        container.appendChild(makeEmojiImg(url));
        continue;
      }
      const chip = document.createElement('span');
      chip.className = 'emoji-chip';
      chip.textContent = m[1];
      container.appendChild(chip);
      continue;
    }
    container.appendChild(document.createTextNode(part));
  }
}

/* ---------------- DOM 构建 ---------------- */

function makeAvatar(user, platform) {
  const wrap = document.createElement('div');
  wrap.className = `avatar ${platform}`;
  const url = user?.avatar || '';
  if (url) {
    const img = document.createElement('img');
    img.src = assetProxy(url);
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => {
      img.remove();
      wrap.textContent = initial(user?.name);
      wrap.style.background = hashColor(user?.name);
    };
    wrap.appendChild(img);
  } else {
    wrap.textContent = initial(user?.name);
    wrap.style.background = hashColor(user?.name);
  }
  return wrap;
}

function makeNameLine(msg) {
  const top = document.createElement('div');
  top.className = 'msg-top';

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = msg.user?.name || '匿名观众';
  top.appendChild(name);

  const plat = document.createElement('span');
  plat.className = `plat ${msg.platform}`;
  plat.textContent = PLATFORM_LABEL[msg.platform] || msg.platform;
  top.appendChild(plat);

  if (msg.user?.medal) {
    const medal = document.createElement('span');
    medal.className = 'medal';
    medal.textContent = msg.user.medalLevel ? `${msg.user.medal} ${msg.user.medalLevel}` : msg.user.medal;
    top.appendChild(medal);
  }
  return top;
}

function buildChat(msg) {
  const row = document.createElement('div');
  row.className = `msg ${msg.platform}`;
  if (msg.kind !== 'chat' && msg.kind !== 'superchat') row.classList.add('system');
  row.dataset.uid = msg.user?.id || '';

  row.appendChild(makeAvatar(msg.user, msg.platform));

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.appendChild(makeNameLine(msg));

  const text = document.createElement('div');
  text.className = 'msg-text';
  if (msg.kind === 'superchat') {
    text.style.color = '#ffd479';
    text.style.fontWeight = '600';
    text.textContent = msg.text || '';
  } else {
    renderRichText(text, msg);
  }
  body.appendChild(text);
  row.appendChild(body);
  return row;
}

function buildGift(msg) {
  const row = document.createElement('div');
  row.className = 'msg gift ' + msg.platform;
  row.dataset.giftKey = msg.giftKey || '';
  row.dataset.uid = msg.user?.id || '';

  const yuan = formatYuan(msg.gift, msg.platform);
  const count = msg.gift?.count || 1;
  const unit = Number(msg.gift?.unitPrice || 0);
  if ((msg.platform === 'douyin' && unit >= 50) || (msg.platform === 'bilibili' && unit >= 50000)) {
    row.classList.add('big');
  }

  row.appendChild(makeAvatar(msg.user, msg.platform));

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.appendChild(makeNameLine(msg));

  const giftBody = document.createElement('div');
  giftBody.className = 'gift-body';

  // 礼物图标：B站新版礼物自带图片，用图比用 emoji 更像样
  if (msg.gift?.image) {
    const img = document.createElement('img');
    img.className = 'gift-img';
    img.src = assetProxy(msg.gift.image);
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => {
      const span = document.createElement('span');
      span.className = 'gift-emoji';
      span.textContent = giftEmoji(msg.gift?.name);
      img.replaceWith(span);
    };
    giftBody.appendChild(img);
  } else {
    const emoji = document.createElement('span');
    emoji.className = 'gift-emoji';
    emoji.textContent = giftEmoji(msg.gift?.name);
    giftBody.appendChild(emoji);
  }

  const name = document.createElement('span');
  name.className = 'gift-name';
  name.textContent = msg.gift?.name || '礼物';
  giftBody.appendChild(name);

  const cnt = document.createElement('span');
  cnt.className = 'gift-count';
  cnt.textContent = `×${count}`;
  giftBody.appendChild(cnt);

  if (yuan) {
    const price = document.createElement('span');
    price.className = 'gift-price';
    price.textContent = yuan;
    giftBody.appendChild(price);
  }

  body.appendChild(giftBody);
  row.appendChild(body);
  return row;
}

/* ---------------- 滚动：翻历史的时候别被新消息拽走 ---------------- */

const NEAR_BOTTOM = 28;

function isPinned(stream) {
  if (!stream) return true;
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight <= NEAR_BOTTOM;
}

function scrollToBottom(stream, smooth = false) {
  if (!stream) return;
  const top = stream.scrollHeight;
  if (smooth && typeof stream.scrollTo === 'function') {
    stream.scrollTo({ top, behavior: 'smooth' });
  } else {
    stream.scrollTop = top;
  }
}

/** 挂上滚动监听，顺便管「有新消息」按钮的显隐 */
function watchScroll(stream, btn) {
  const sync = () => {
    if (!btn) return;
    btn.hidden = isPinned(stream);
  };
  stream.addEventListener('scroll', sync, { passive: true });
  if (btn) btn.addEventListener('click', () => scrollToBottom(stream, true));
  return sync;
}

const syncChatScroll = watchScroll(el.chatStream, document.getElementById('chatToBottom'));
const syncGiftScroll = watchScroll(el.giftStream, document.getElementById('giftToBottom'));

/* ---------------- 挂载 / 淘汰 ---------------- */

/** 超出上限就把最老的删掉；用户正翻历史时补偿滚动位置，避免画面跳动 */
function trim(stream, max) {
  if (stream.children.length <= max) return;
  const pinned = isPinned(stream);
  const beforeTop = stream.scrollTop;
  const beforeHeight = stream.scrollHeight;

  while (stream.children.length > max) {
    const first = stream.children[0];
    if (first.dataset?.giftKey) giftIndex.delete(first.dataset.giftKey);
    stream.removeChild(first);
  }

  if (!pinned) {
    const removed = beforeHeight - stream.scrollHeight;
    if (removed > 0) stream.scrollTop = Math.max(0, beforeTop - removed);
  }
}

function appendChat(msg) {
  if (!shouldShow(msg)) return;
  const pinned = isPinned(el.chatStream);
  el.chatStream.appendChild(buildChat(msg));
  chatCount++;
  trim(el.chatStream, cfg.display.maxDanmaku || 200);
  el.chatCount.textContent = String(chatCount);
  if (pinned) scrollToBottom(el.chatStream);
  syncChatScroll();
}

function appendGift(msg) {
  if (msg.kind === 'superchat') {
    appendChat(msg);
    return;
  }
  const key = msg.giftKey;
  const now = Date.now();

  // 同一用户同一礼物连击 → 就地更新数字，不刷屏
  if (key && giftIndex.has(key)) {
    const rec = giftIndex.get(key);
    if (rec.node.isConnected && now - rec.at < 8000) {
      rec.at = now;
      const countEl = rec.node.querySelector('.gift-count');
      if (countEl) countEl.textContent = `×${msg.gift?.count || 1}`;
      const priceEl = rec.node.querySelector('.gift-price');
      const yuan = formatYuan(msg.gift, msg.platform);
      if (priceEl && yuan) priceEl.textContent = yuan;
      rec.node.classList.remove('bump');
      void rec.node.offsetWidth;
      rec.node.classList.add('bump');
      return;
    }
    giftIndex.delete(key);
  }

  const pinned = isPinned(el.giftStream);
  const row = buildGift(msg);
  el.giftStream.appendChild(row);
  if (key) giftIndex.set(key, { node: row, at: now });
  giftCount++;
  trim(el.giftStream, cfg.display.maxGifts || 30);
  el.giftCount.textContent = String(giftCount);
  if (pinned) scrollToBottom(el.giftStream);
  syncGiftScroll();
}

/** 头像 / 昵称晚到：按 uid 回填已有行 */
function patchUser(uid, patch) {
  if (!uid || !patch) return;
  const rows = document.querySelectorAll(`.msg[data-uid="${CSS.escape(String(uid))}"]`);
  for (const row of rows) {
    if (patch.name) {
      const nameEl = row.querySelector('.name');
      const cur = nameEl?.textContent || '';
      if (nameEl && (cur.includes('*') || cur === '匿名观众')) nameEl.textContent = patch.name;
    }
    if (patch.avatar) {
      const av = row.querySelector('.avatar');
      if (av && !av.querySelector('img')) {
        const img = document.createElement('img');
        img.src = assetProxy(patch.avatar);
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.remove();
        av.textContent = '';
        av.style.background = '';
        av.appendChild(img);
      }
    }
  }
}

/* ---------------- 头部状态 ---------------- */

function platformActive(id) {
  const p = platformState[id] || {};
  return !!cfg.rooms?.[id]?.roomId || ['connecting', 'connected', 'error', 'reconnecting'].includes(p.status);
}

function renderPlatforms() {
  el.platforms.innerHTML = '';
  let titleSet = false;

  for (const id of ['bilibili', 'douyin']) {
    if (!platformActive(id)) continue;
    const p = platformState[id] || {};

    // 「连上了」和「房间在直播」是两回事：
    // 已连接但未开播时用琥珀色提示，别让人以为在收流却没消息
    const connected = p.status === 'connected';
    const live = connected && p.live === true;

    const pill = document.createElement('div');
    pill.className = `pill ${id} ${live ? 'live' : connected ? 'waiting' : 'offline'}`;
    const bits = [PLATFORM_FULL[id], p.title, p.anchor && `主播 ${p.anchor}`];
    if (connected && !live) bits.push('房间未开播');
    if (p.error) bits.push(p.error);
    pill.title = bits.filter(Boolean).join(' · ');

    const dot = document.createElement('span');
    dot.className = 'dot';
    pill.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = PLATFORM_LABEL[id];
    pill.appendChild(label);
    el.platforms.appendChild(pill);

    if (!titleSet && (p.title || p.anchor)) {
      titleSet = true;
      el.title.textContent = cfg.display.title || p.title || '直播弹幕';
      const row = [];
      if (p.anchor) row.push(`主播 ${p.anchor}`);
      const other = platformState[id === 'bilibili' ? 'douyin' : 'bilibili'];
      if (other?.status === 'connected') row.push('B站 + 抖音 同屏');
      el.subtitle.textContent = row.join(' · ');
    }
  }

  if (!titleSet) {
    el.title.textContent = cfg.display.title || '直播弹幕';
    el.subtitle.textContent = '等待接入直播间';
  }
  document.getElementById('head').style.display = cfg.display.showHeader === false ? 'none' : '';
  renderOnline();
}

/** 顶部在线观众：两个平台相加给总数，右边是分平台明细 */
function renderOnline() {
  const b = platformState.bilibili || {};
  const d = platformState.douyin || {};
  const bili = Number(b.online || 0) || 0;
  const dy = Number(d.online || 0) || 0;

  if (!bili && !dy) {
    el.onlineBar.hidden = true;
    return;
  }
  el.onlineBar.hidden = false;
  el.onlineTotal.textContent = compactNum(bili + dy);

  const bits = [];
  if (platformActive('bilibili') && bili) bits.push(`<span class="bilibili">B站 <b>${compactNum(bili)}</b></span>`);
  if (platformActive('douyin') && dy) bits.push(`<span class="douyin">抖音 <b>${compactNum(dy)}</b></span>`);
  // 只有一路在线时，明细和总数一样，就不重复显示了
  el.onlineSplit.innerHTML = bits.length > 1 ? bits.join('') : '';
}

/* ---------------- 空状态 ---------------- */

function showEmpty(force = false) {
  const connected = ['bilibili', 'douyin'].map((id) => platformState[id]).filter(Boolean);
  const anyConnected = connected.some((p) => p.status === 'connected');
  const anyLive = connected.some((p) => p.status === 'connected' && p.live === true);

  const chatHint =
    anyConnected && !anyLive
      ? '直播间已经连上，等主播开播…'
      : anyConnected
        ? '正在收消息…'
        : '打开 <kbd>控制台</kbd> 填房间号，或先看演示效果';

  const make = (text, target) => {
    if (force) {
      const old = target.querySelector('.empty');
      if (old) old.remove();
    }
    if (target.children.length) return;
    const div = document.createElement('div');
    div.className = 'empty';
    div.innerHTML = text;
    target.appendChild(div);
    target.classList.add('is-empty');
  };

  make(`还没有礼物<br /><span style="opacity:.6">配好房间号后，礼物会显示在这里</span>`, el.giftStream);
  make(`还没有弹幕<br /><span style="opacity:.6">${chatHint}</span>`, el.chatStream);
}

function clearEmpty() {
  for (const s of [el.giftStream, el.chatStream]) {
    const e = s.querySelector('.empty');
    if (e) e.remove();
    s.classList.remove('is-empty');
  }
}

/* ---------------- 连接服务端 ---------------- */

let ws = null;
let retry = 0;

function handleMessage(m) {
  if (m.kind === 'user') {
    patchUser(m.user?.id, { name: m.user?.name, avatar: m.user?.avatar });
    return;
  }
  clearEmpty();
  if (m.kind === 'gift') appendGift(m);
  else appendChat(m);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    retry = 0;
  };

  ws.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (data.type) {
      case 'hello': {
        platformState = data.state?.platforms || platformState;
        if (data.emoji) emojiMaps = { ...emojiMaps, ...data.emoji };
        renderPlatforms();
        if (Array.isArray(data.recent) && data.recent.length) {
          clearEmpty();
          for (const m of data.recent) {
            if (m.silent) continue;
            if (m.kind === 'gift') appendGift(m);
            else if (m.kind === 'user') patchUser(m.user?.id, m.user);
            else appendChat(m);
          }
          // 补历史消息时不逐条滚，最后一次性落到底部
          scrollToBottom(el.chatStream);
          scrollToBottom(el.giftStream);
          syncChatScroll();
          syncGiftScroll();
        } else {
          showEmpty();
        }
        break;
      }
      case 'message':
        handleMessage(data.message);
        break;
      case 'platform': {
        platformState[data.platform.id] = data.platform;
        renderPlatforms();
        // 空状态提示跟着连接/开播状态走
        if (el.chatStream.querySelector('.empty')) showEmpty(true);
        break;
      }
      case 'emoji': {
        emojiMaps[data.platform] = { ...(emojiMaps[data.platform] || {}), ...data.map };
        break;
      }
      case 'config': {
        cfg = data.config || cfg;
        renderPlatforms();
        break;
      }
    }
  };

  ws.onclose = () => {
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, Math.min(800 * 2 ** retry, 8000));
  };
  ws.onerror = () => ws.close();
}

/* ---------------- 启动 ---------------- */

async function boot() {
  try {
    const r = await fetch('/api/state');
    const j = await r.json();
    cfg = j.config || cfg;
    platformState = j.state?.platforms || platformState;
  } catch {}
  renderPlatforms();
  showEmpty();
  connect();
}

boot();
