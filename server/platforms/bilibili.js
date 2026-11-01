/**
 * B 站直播弹幕接入。
 *
 * 流程：room_init(短号→真实房号) → WBI 签名拿 getDanmuInfo(token + 弹幕服务器)
 *       → wss://…/sub 握手(op7) → 心跳(op2) → 收 op5 广播包(可能 brotli/zlib 压缩)
 *
 * 几个容易踩的点：
 * - getDanmuInfo 会被风控返回 -352，必须带 buvid3 + WBI 签名。
 * - 礼物消息现在叫 SEND_GIFT_V2，内容是 base64 的裸 protobuf，不是 JSON。
 * - 弹幕包本身没有头像，要按 uid 反查 x/web-interface/card。
 * - 未登录时部分昵称会被平台打码成 `一***`，填了 Cookie 才会恢复正常。
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { push, setPlatform, setEmojiMap, recordMethod } from '../hub.js';
import { decodeGiftV2 } from './bilibili-pb.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const WBI_MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const mixinKey = (orig) => WBI_MIXIN.map((i) => orig[i]).join('').slice(0, 32);

/** WBI 签名，B 站 2023 年后大部分 web 接口都要 */
function wbiSign(params, imgKey, subKey) {
  const mixin = mixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const p = { ...params, wts };
  const query = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}

/* ---------------- 弹幕协议包 ---------------- */

function readPackets(buf) {
  const out = [];
  let off = 0;
  while (off + 16 <= buf.length) {
    const plen = buf.readInt32BE(off);
    const hlen = buf.readInt16BE(off + 4);
    const ver = buf.readInt16BE(off + 6);
    const op = buf.readInt32BE(off + 8);
    if (plen < hlen || off + plen > buf.length) break;
    out.push({ ver, op, body: buf.subarray(off + hlen, off + plen) });
    off += plen;
  }
  return out;
}

function encodePacket(op, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const head = Buffer.alloc(16);
  head.writeInt32BE(16 + b.length, 0);
  head.writeInt16BE(16, 4);
  head.writeInt16BE(1, 6);
  head.writeInt32BE(op, 8);
  head.writeInt32BE(1, 12);
  return Buffer.concat([head, b]);
}

function expandPackets(packet) {
  if (packet.ver === 2) {
    try {
      return readPackets(zlib.inflateSync(packet.body)).map((p) => p.body.toString('utf8'));
    } catch {
      return [];
    }
  }
  if (packet.ver === 3) {
    try {
      return readPackets(zlib.brotliDecompressSync(packet.body)).map((p) => p.body.toString('utf8'));
    } catch {
      return [];
    }
  }
  return [packet.body.toString('utf8')];
}

/* ---------------- 用户信息（头像 + 真实昵称） ---------------- */

const MASK_RE = /\*{2,}/;

export function isMaskedName(name) {
  return MASK_RE.test(String(name || ''));
}

class UserCache {
  constructor(cookie) {
    this.cookie = cookie;
    this.map = new Map(); // id -> { name, face }
    this.queue = [];
    this.running = 0;
    this.max = 5;
    this.queueLimit = 400;
  }

  get(id) {
    return this.map.get(String(id)) || null;
  }

  fetch(id) {
    const key = String(id);
    if (!id || key === '0') return;
    if (this.map.has(key)) return;
    this.map.set(key, null); // 占位，避免重复入队
    if (this.queue.length > this.queueLimit) return;
    this.queue.push(key);
    this.pump();
  }

  async pump() {
    while (this.running < this.max && this.queue.length) {
      const uid = this.queue.shift();
      this.running++;
      this.resolve(uid)
        .then((info) => {
          if (info && (info.name || info.face)) {
            this.map.set(uid, info);
            this.onResolved?.(uid, info);
          } else {
            this.map.delete(uid); // 没拿到，下次再试
          }
        })
        .catch(() => this.map.delete(uid))
        .finally(() => {
          this.running--;
          setTimeout(() => this.pump(), 150);
        });
    }
  }

  async resolve(uid) {
    const headers = { 'user-agent': UA, referer: 'https://live.bilibili.com/' };
    if (this.cookie) headers.cookie = this.cookie;
    const r = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${uid}&photo=false`, { headers });
    const j = await r.json();
    if (j?.code !== 0) return null;
    const card = j.data?.card || {};
    return { name: card.name || '', face: card.face || '' };
  }
}

/* ---------------- 登录态检查（控制台用） ---------------- */

export async function checkLogin(cookie) {
  try {
    const headers = { 'user-agent': UA, referer: 'https://live.bilibili.com/' };
    if (cookie) headers.cookie = cookie;
    const j = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers })).json();
    if (j?.code === 0 && j?.data?.isLogin) {
      return { loggedIn: true, uname: j.data.uname || '', mid: j.data.mid || 0 };
    }
    return { loggedIn: false, uname: '', mid: 0, code: j?.code ?? -1 };
  } catch (e) {
    return { loggedIn: false, error: e.message };
  }
}

/* ---------------- 连接器 ---------------- */

export class BilibiliSource {
  constructor({ roomId, cookie }, { log = console.log } = {}) {
    // 允许直接粘 https://live.bilibili.com/21452505 这种链接
    const raw = String(roomId || '').trim();
    const fromUrl = /live\.bilibili\.com\/(\d+)/i.exec(raw);
    this.input = fromUrl ? fromUrl[1] : raw.replace(/[^\d]/g, '') || raw;
    this.cookie = String(cookie || '').trim();
    this.log = log;
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.users = new UserCache(this.cookie);
    this.buvid = '';
    this.wbi = null;
    this.roomId = '';
    this.hbTimer = null;
    this.reconnectTimer = null;
    this.emojiMap = null;

    this.users.onResolved = (uid, info) => {
      push({
        platform: 'bilibili',
        kind: 'user',
        silent: true,
        user: { id: String(uid), name: info.name, avatar: info.face },
      });
    };
  }

  async start() {
    setPlatform('bilibili', { status: 'connecting', roomId: this.input, error: '' });
    try {
      await this.bootstrap();
    } catch (e) {
      setPlatform('bilibili', { status: 'error', error: String(e.message || e) });
      this.scheduleReconnect();
      return;
    }
    this.connect();
  }

  stop() {
    this.closed = true;
    clearInterval(this.hbTimer);
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {}
    setPlatform('bilibili', { status: 'idle', online: 0 });
  }

  async headers(extra = {}) {
    const h = { 'user-agent': UA, referer: `https://live.bilibili.com/${this.roomId || ''}`, ...extra };
    const ck = [this.cookie, this.buvid].filter(Boolean).join('; ');
    if (ck) h.cookie = ck;
    return h;
  }

  async bootstrap() {
    // 1. buvid（风控指纹）
    try {
      const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': UA } });
      const j = await r.json();
      if (j?.data?.b_3) this.buvid = `buvid3=${j.data.b_3}; buvid4=${j.data.b_4 || ''}`;
    } catch {}

    // 2. WBI 密钥
    const nav = await (
      await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: await this.headers() })
    ).json();
    const wbiImg = nav?.data?.wbi_img;
    if (!wbiImg?.img_url) throw new Error('拿不到 WBI 密钥（接口可能被风控）');
    this.wbi = {
      imgKey: wbiImg.img_url.split('/').pop().split('.')[0],
      subKey: wbiImg.sub_url.split('/').pop().split('.')[0],
    };
    this.loggedIn = !!nav?.data?.isLogin;

    // 3. 短号 → 真实房号
    if (!this.input) throw new Error('未填写 B 站房间号');
    const init = await (
      await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${this.input}`, {
        headers: await this.headers(),
      })
    ).json();
    if (init.code !== 0) throw new Error(`房间解析失败：${init.message || init.code}`);
    this.roomId = init.data.room_id;
    this.liveStatus = init.data.live_status;

    // 4. 房间信息（标题/主播/在线）
    await this.fetchRoomInfo();

    // 5. 弹幕服务器 token
    const qs = wbiSign({ id: this.roomId, type: 0 }, this.wbi.imgKey, this.wbi.subKey);
    const info = await (
      await fetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${qs}`, {
        headers: await this.headers(),
      })
    ).json();
    if (info.code !== 0 || !info.data?.token) throw new Error(`弹幕服务器获取失败：${info.message || info.code}`);
    this.token = info.data.token;
    this.hosts = info.data.host_list || [];

    // 6. 表情包（需要登录才有，拿不到就算了）
    this.loadEmoticons().catch(() => {});

    this.log(
      `[B站] 房间 ${this.roomId} 已就绪，主播 ${this.anchorName || '-'}${
        this.loggedIn ? '（已登录）' : '（未登录，部分昵称可能被打码）'
      }`,
    );
  }

  async fetchRoomInfo() {
    try {
      const info = await (
        await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${this.roomId}`, {
          headers: await this.headers(),
        })
      ).json();
      if (info.code === 0) {
        this.anchorUid = info.data.uid;
        this.liveStatus = info.data.live_status;
        this.title = info.data.title || '';
        // 注意：get_info 的 online 是「人气值」，不是在线观众数，
        // 真正的在线观众来自 ONLINE_RANK_COUNT.online_count，所以这里不放 online
        setPlatform('bilibili', {
          title: this.title,
          popularity: Number(info.data.online || 0) || 0,
          live: info.data.live_status === 1,
        });
      }
      if (this.anchorUid) {
        const m = await (
          await fetch(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${this.anchorUid}`, {
            headers: await this.headers(),
          })
        ).json();
        this.anchorName = m?.data?.info?.uname || '';
        setPlatform('bilibili', { anchor: this.anchorName, avatar: m?.data?.info?.face || '' });
      }
    } catch (e) {
      this.log('[B站] 房间信息获取失败', e.message);
    }
  }

  /** 拉一次表情包，做成「花」→ 图片地址 的映射，交给前端替换 [花] */
  async loadEmoticons() {
    if (!this.cookie) return;
    const u = `https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons?platform=pc&room_id=${this.roomId}`;
    const j = await (await fetch(u, { headers: await this.headers() })).json();
    if (j?.code !== 0 || !j.data?.data) return;
    const map = {};
    for (const pkg of j.data.data) {
      for (const e of pkg.emoticons || []) {
        // 接口返回的名字自带方括号（"[花]"），弹幕文本里也是 "[花]"，
        // 但前端是按括号里的名字查表的，所以统一去掉括号当 key
        const raw = e.emoji || e.emoticon_name || '';
        const name = String(raw).replace(/^\[|\]$/g, '').trim();
        const url = (e.url || '').replace(/^http:/, 'https:');
        if (name && url) map[name] = url;
      }
    }
    if (Object.keys(map).length) {
      this.emojiMap = map;
      setEmojiMap('bilibili', map);
      this.log(`[B站] 已加载 ${Object.keys(map).length} 个表情`);
    }
  }

  connect() {
    if (this.closed) return;
    const host = this.hosts?.[0];
    if (!host) {
      this.scheduleReconnect();
      return;
    }
    const url = `wss://${host.host}:${host.wss_port}/sub`;
    this.log(`[B站] 连接弹幕服务器 ${url}`);
    const ws = new WebSocket(url, { headers: { 'user-agent': UA, origin: 'https://live.bilibili.com' } });
    this.ws = ws;

    ws.on('open', () => {
      this.retry = 0;
      const uid = (this.cookie.match(/DedeUserID=(\d+)/) || [])[1] || 0;
      const auth = {
        uid: Number(uid),
        roomid: this.roomId,
        protover: 3,
        platform: 'web',
        type: 2,
        key: this.token,
        buvid: (this.buvid.match(/buvid3=([^;]+)/) || [])[1] || '',
      };
      ws.send(encodePacket(7, JSON.stringify(auth)));
      clearInterval(this.hbTimer);
      this.hbTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(encodePacket(2, ''));
      }, 30000);
    });

    ws.on('message', (data) => this.onData(data));

    ws.on('error', (e) => {
      this.log('[B站] WS 错误', e.message);
      setPlatform('bilibili', { status: 'error', error: e.message });
    });

    ws.on('close', () => {
      clearInterval(this.hbTimer);
      if (this.closed) return;
      setPlatform('bilibili', { status: 'reconnecting' });
      this.scheduleReconnect();
    });
  }

  onData(data) {
    let packets;
    try {
      packets = readPackets(data);
    } catch {
      return;
    }
    for (const p of packets) {
      if (p.op === 8) {
        const body = p.body.toString('utf8');
        if (!body.includes('"code":0')) {
          this.log('[B站] 鉴权失败', body);
          setPlatform('bilibili', { status: 'error', error: '弹幕鉴权失败' });
        } else {
          setPlatform('bilibili', { status: 'connected', error: '' });
        }
        continue;
      }
      if (p.op !== 5) continue;
      for (const text of expandPackets(p)) {
        if (!text || text[0] !== '{') continue;
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          continue;
        }
        try {
          this.handle(msg);
        } catch (e) {
          this.log('[B站] 消息处理异常', msg.cmd, e.message);
        }
      }
    }
  }

  handle(msg) {
    const cmd = msg.cmd || '';
    recordMethod('bilibili', cmd);
    if (cmd.startsWith('DANMU_MSG')) return this.onDanmaku(msg);
    if (cmd === 'SEND_GIFT_V2') return this.onGiftV2(msg);
    if (cmd === 'SEND_GIFT') return this.onGift(msg);
    if (cmd === 'SUPER_CHAT_MESSAGE') return this.onSuperChat(msg);
    if (cmd === 'GUARD_BUY') return this.onGuard(msg);
    if (cmd === 'INTERACT_WORD' || cmd === 'INTERACT_WORD_V2') return this.onInteract(msg);
    if (cmd === 'ONLINE_RANK_COUNT') {
      const d = msg.data || {};
      const online = Number(d.online_count ?? d.count ?? 0) || 0;
      setPlatform('bilibili', { online });
      return;
    }
    if (cmd === 'WATCHED_CHANGE') {
      const n = Number(msg?.data?.num ?? 0) || 0;
      setPlatform('bilibili', { watched: n });
      return;
    }
    if (cmd === 'ROOM_REAL_TIME_MESSAGE_UPDATE') {
      const d = msg.data || {};
      setPlatform('bilibili', { fans: Number(d.fans ?? 0) || 0 });
      return;
    }
    if (cmd === 'STOP_LIVE_ROOM' || cmd === 'STOP_LIVE_ROOM_LIST') {
      setPlatform('bilibili', { live: false });
      return;
    }
    // 礼物相关的 cmd 改名时留个痕迹
    if (/gift/i.test(cmd)) this.log('[B站] 未识别的礼物类消息：', cmd);
  }

  onDanmaku(msg) {
    const info = msg.info || [];
    const rawText = String(info[1] ?? '');
    const userInfo = info[2] || [];
    const uid = userInfo[0];
    let name = userInfo[1] || '';
    const medal = info[3] || [];

    // 表情：大表情的内容就是一个表情名，图片地址在 info[0][13]
    const emojiMeta = Array.isArray(info[0]) ? info[0][13] : null;
    const emoji = emojiMeta?.url
      ? {
          url: String(emojiMeta.url).replace(/^http:/, 'https:'),
          width: emojiMeta.width,
          height: emojiMeta.height,
        }
      : null;

    const cached = this.users.get(uid);
    if (cached?.name && isMaskedName(name)) name = cached.name;
    if (!name) name = cached?.name || '匿名观众';

    // 名字被打码 / 还没头像 → 去查一下
    if (uid && (isMaskedName(name) || !cached?.face)) this.users.fetch(uid);

    push({
      platform: 'bilibili',
      kind: 'chat',
      user: {
        id: String(uid ?? ''),
        name,
        avatar: cached?.face || '',
        level: info[4] ?? null,
        medal: medal[1] && medal[0] > 0 ? medal[1] : '',
        medalLevel: medal[0] > 0 ? medal[0] : null,
        admin: !!userInfo[2],
      },
      text: rawText,
      emoji,
    });
  }

  /** 新版礼物消息：data.pb 是 base64 的 protobuf */
  onGiftV2(msg) {
    let g;
    try {
      g = decodeGiftV2(msg?.data?.pb);
    } catch (e) {
      this.log('[B站] 礼物解析失败', e.message);
      return;
    }
    if (!g.giftName) return;

    let name = g.uname || '';
    const cached = this.users.get(g.uid);
    if (isMaskedName(name) && cached?.name) name = cached.name;
    if (g.uid && (isMaskedName(name) || !g.face)) this.users.fetch(g.uid);
    if (!name || isMaskedName(name)) name = cached?.name || name || '匿名观众';

    push({
      platform: 'bilibili',
      kind: 'gift',
      // batch_combo_id：一次「连击」共享同一个 id，两次单独赠送 id 不同。
      // 实测每条礼物消息的 combo id 都是唯一的，所以用它既能合并连击，又不会吞掉隔几秒的第二次赠送。
      giftKey: g.comboId || `${g.uid || name}:${g.giftName}:${Date.now()}`,
      user: {
        id: String(g.uid || ''),
        name,
        avatar: g.face || cached?.face || '',
        medal: g.medalName || '',
        medalLevel: g.medalLevel || null,
      },
      gift: {
        name: g.giftName,
        count: g.num,
        unitPrice: g.price,
        coinType: g.coinType,
        image: g.image,
      },
      text: g.action || '',
    });
  }

  /** 老版礼物消息（部分房间还会下发） */
  onGift(msg) {
    const d = msg.data || {};
    let name = d.uname || '匿名';
    const cached = this.users.get(d.uid);
    if (isMaskedName(name) && cached?.name) name = cached.name;
    if (d.uid && !d.face) this.users.fetch(d.uid);
    push({
      platform: 'bilibili',
      kind: 'gift',
      giftKey: d.batch_combo_id || `${d.uid ?? ''}:${d.giftName ?? d.giftId ?? ''}:${Date.now()}`,
      user: { id: String(d.uid ?? ''), name, avatar: d.face || cached?.face || '' },
      gift: {
        name: d.giftName || '礼物',
        count: d.num ?? 1,
        unitPrice: d.price ?? 0,
        coinType: d.coin_type || 'gold',
      },
      text: d.action || '',
    });
  }

  onSuperChat(msg) {
    const d = msg.data || {};
    push({
      platform: 'bilibili',
      kind: 'superchat',
      user: {
        id: String(d.uid ?? ''),
        name: d?.user_info?.uname || '匿名',
        avatar: d?.user_info?.face || '',
      },
      text: d.message || '',
      gift: { name: '醒目留言', count: 1, unitPrice: d.price ?? 0, coinType: 'cny', total: d.price ?? 0 },
      color: d.background_color || '',
    });
  }

  onGuard(msg) {
    const d = msg.data || {};
    push({
      platform: 'bilibili',
      kind: 'gift',
      user: { id: String(d.uid ?? ''), name: d.username || '匿名', avatar: this.users.get(d.uid)?.face || '' },
      gift: { name: d.gift_name || '大航海', count: d.num ?? 1, unitPrice: d.price ?? 0, coinType: 'gold' },
      text: '开通了',
    });
    if (d.uid) this.users.fetch(d.uid);
  }

  onInteract(msg) {
    const d = msg.data || {};
    const base = d.uinfo?.base || {};
    const name = d.uname || base.name || '';
    const uid = d.uid || base.uid;
    if (!name) return;
    const avatar = d.face || base.face || this.users.get(uid)?.face || '';
    if (uid && !avatar) this.users.fetch(uid);
    if (d.msg_type === 1) {
      push({
        platform: 'bilibili',
        kind: 'enter',
        user: { id: String(uid ?? ''), name, avatar },
        text: '进入了直播间',
      });
    } else if (d.msg_type === 2) {
      push({
        platform: 'bilibili',
        kind: 'follow',
        user: { id: String(uid ?? ''), name, avatar },
        text: '关注了主播',
      });
    }
  }

  scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    this.retry = Math.min(this.retry + 1, 8);
    const wait = Math.min(1000 * 2 ** this.retry, 30000);
    setPlatform('bilibili', { status: 'reconnecting' });
    this.log(`[B站] ${Math.round(wait / 1000)}s 后重连（第 ${this.retry} 次）`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.bootstrap();
        this.connect();
      } catch (e) {
        setPlatform('bilibili', { status: 'error', error: String(e.message || e) });
        this.scheduleReconnect();
      }
    }, wait);
  }
}
