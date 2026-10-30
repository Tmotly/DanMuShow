/**
 * 消息枢纽：把两个平台的事件归一化成同一种结构，缓存最近若干条，
 * 并广播给所有展示端（浏览器 / OBS 浏览器源）。
 */

let seq = 0;

/** 各平台连接状态 */
export const state = {
  startedAt: Date.now(),
  platforms: {
    bilibili: {
      id: 'bilibili',
      label: 'B站',
      status: 'idle',
      roomId: '',
      title: '',
      anchor: '',
      avatar: '',
      online: 0,
      watched: 0,
      popularity: 0,
      fans: 0,
      live: false,
      loggedIn: false,
      error: '',
    },
    douyin: {
      id: 'douyin',
      label: '抖音',
      status: 'idle',
      roomId: '',
      title: '',
      anchor: '',
      avatar: '',
      online: 0,
      watched: 0,
      popularity: 0,
      fans: 0,
      live: false,
      loggedIn: false,
      error: '',
    },
  },
};

/** 表情名 → 图片地址（B 站登录后才有），前端用来把 [花] 换成图 */
const emojiMaps = { bilibili: {}, douyin: {} };

const recent = [];
const MAX_RECENT = 200;
const clients = new Set();

export function setPlatform(id, patch) {
  const p = state.platforms[id];
  if (!p) return;
  Object.assign(p, patch);
  broadcast({ type: 'platform', platform: { ...p } });
}

export function setEmojiMap(platform, map) {
  if (!map || !Object.keys(map).length) return;
  emojiMaps[platform] = { ...emojiMaps[platform], ...map };
  broadcast({ type: 'emoji', platform, map: emojiMaps[platform] });
}

export function getEmojiMaps() {
  return emojiMaps;
}

export function onClient(ws) {
  clients.add(ws);
  ws.send(
    JSON.stringify({
      type: 'hello',
      state: snapshot(),
      emoji: emojiMaps,
      recent: recent.slice(-150),
    }),
  );
  return () => clients.delete(ws);
}

function snapshot() {
  return {
    startedAt: state.startedAt,
    platforms: {
      bilibili: { ...state.platforms.bilibili },
      douyin: { ...state.platforms.douyin },
    },
  };
}

export function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    // 1 === OPEN
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {
        clients.delete(ws);
      }
    }
  }
}

/**
 * 归一化消息结构：
 * {
 *   id, platform, kind: 'chat'|'gift'|'superchat'|'enter'|'follow'|'like'|'user',
 *   user: { id, name, avatar, level, medal },
 *   text, emoji: {url,width,height}, gift: { name, count, unitPrice, coinType }, ts
 * }
 * kind='user' 是静默的头像/昵称补全，前端按 uid 回填已有行。
 */

/** 本地监听（日志 / 调试用，不影响广播） */
const listeners = new Set();
export function onMessage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function push(normalized) {
  const msg = {
    id: `${normalized.platform}-${Date.now()}-${++seq}`,
    ts: Date.now(),
    ...normalized,
  };
  // 记一下“最后收到消息的时间”，控制台用它判断「连上了但没消息」还是真没动静
  const plat = state.platforms[normalized.platform];
  if (plat && normalized.kind !== 'user') plat.lastMessageAt = msg.ts;
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch {}
  }
  recent.push(msg);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  broadcast({ type: 'message', message: msg });
  return msg;
}

export function stats() {
  return {
    recent: recent.length,
    clients: clients.size,
  };
}
