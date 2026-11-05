/**
 * 抖音直播弹幕接入。
 *
 * 流程：房间号(web_rid) → enter 接口换到内部 room_id → 用 webmssdk 算签名
 *       → wss://webcast…/webcast/im/push/v2/ 收 PushFrame → gzip → protobuf
 *
 * 只读接入，不需要登录、不需要直播伴侣。
 * 头像：User.avatarThumb 的第 1 号字段就是地址列表，直接有。
 */
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { get_sign } from '../../vendor/douyin/webmssdk.js';
import { pb, imageUrl } from './douyin-pb.js';
import { collectStrings } from '../lib/pb.js';
import { push, setPlatform, recordMethod } from '../hub.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
// 实测三个集群（webcast100/lf/lq）推送的消息集合完全一致，用默认这个即可
const WS_HOST = 'webcast100-ws-web-hl.douyin.com';
const SDK_VERSION = '1.0.15';
const VERSION_CODE = 180800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function cookieHeaderFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const map = new Map();
  for (const c of raw) {
    const first = String(c).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function mergeCookies(a, b) {
  const map = new Map();
  for (const part of `${a}; ${b}`.split(';')) {
    const kv = part.trim();
    if (!kv) continue;
    const i = kv.indexOf('=');
    if (i > 0) map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 允许直接粘 https://live.douyin.com/123456 这种链接 */
export function parseRoomInput(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const fromUrl = /live\.douyin\.com\/([A-Za-z0-9_-]+)/i.exec(s);
  if (fromUrl) return fromUrl[1];
  return s.replace(/[^\w-]/g, '');
}

function buildWsUrl(roomId, host = WS_HOST) {
  const userUniqueId = (
    Math.floor(Math.random() * (7999999999999999999 - 7300000000000000000)) + 7300000000000000000
  ).toString();
  const sigParams = {
    live_id: '1',
    aid: '6383',
    version_code: VERSION_CODE,
    webcast_sdk_version: SDK_VERSION,
    room_id: roomId,
    sub_room_id: '',
    sub_channel_id: '',
    did_rule: '3',
    user_unique_id: userUniqueId,
    device_platform: 'web',
    device_type: '',
    ac: '',
    identity: 'audience',
  };
  const signature = get_sign(md5(Object.entries(sigParams).map(([k, v]) => `${k}=${v}`).join(',')));
  const params = {
    app_name: 'douyin_web',
    room_id: roomId,
    compress: 'gzip',
    version_code: String(VERSION_CODE),
    webcast_sdk_version: SDK_VERSION,
    update_version_code: SDK_VERSION,
    live_id: '1',
    did_rule: '3',
    user_unique_id: userUniqueId,
    identity: 'audience',
    signature: String(signature),
    device_platform: 'web',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version:
      '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    browser_online: 'true',
    tz_name: 'Etc/GMT-8',
    host: 'https://live.douyin.com',
    aid: '6383',
    endpoint: 'live_pc',
    support_wrds: '1',
    im_path: '/webcast/im/fetch/',
    need_persist_msg_count: '15',
    heartbeatDuration: '0',
  };
  return `wss://${host}/webcast/im/push/v2/?${new URLSearchParams(params).toString()}`;
}

export class DouyinSource {
  constructor({ roomId, cookie }, { log = console.log, host = WS_HOST } = {}) {
    this.input = parseRoomInput(roomId);
    this.userCookie = String(cookie || '').trim();
    this.cookie = this.userCookie;
    this.log = log;
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.hbTimer = null;
    this.reconnectTimer = null;
    this.roomId = '';
    this.host = host;
    this.likeBuffer = 0;
    this.likeTimer = null;
  }

  async start() {
    setPlatform('douyin', { status: 'connecting', roomId: this.input, error: '' });
    this.startRoomWatch();
    try {
      await this.resolveRoom();
    } catch (e) {
      setPlatform('douyin', { status: 'error', error: String(e.message || e) });
      this.scheduleReconnect();
      return;
    }
    this.connect();
  }

  stop() {
    this.closed = true;
    clearInterval(this.hbTimer);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.roomTimer);
    try {
      this.ws?.terminate();
    } catch {}
    setPlatform('douyin', { status: 'idle', online: 0 });
  }

  /**
   * 抖音的内部 room_id 会随每次开播变化。
   * 如果填房间号时对方还没开播，解析到的是旧会话的 id，开播后连上去是收不到消息的。
   * 所以每隔一段时间重新解析一次，id 变了就重连。
   */
  startRoomWatch() {
    clearInterval(this.roomTimer);
    this.roomTimer = setInterval(() => {
      if (this.closed || this.resolving) return;
      this.refreshRoom();
    }, 60000);
  }

  async refreshRoom() {
    if (this.resolving) return;
    this.resolving = true;
    const before = this.roomId;
    try {
      await this.resolveRoom();
    } catch (e) {
      this.log('[抖音] 房间信息刷新失败', e.message);
      return;
    } finally {
      this.resolving = false;
    }
    if (this.roomId && this.roomId !== before) {
      this.log(`[抖音] 房间 id 变了（${before} → ${this.roomId}），重连弹幕`);
      this.reconnectNow();
    }
  }

  /** 立刻重连（关掉旧连接，不走退避） */
  reconnectNow() {
    clearTimeout(this.reconnectTimer);
    this.retry = 0;
    const old = this.ws;
    this.ws = null;
    if (old) {
      try {
        old.removeAllListeners();
        old.terminate();
      } catch {}
    }
    clearInterval(this.hbTimer);
    this.connect();
  }

  /** 短号 → 内部 room_id，顺便拿标题和主播信息 */
  async resolveRoom() {
    if (!this.input) throw new Error('未填写抖音房间号');

    if (!this.cookie) {
      const home = await fetch('https://live.douyin.com/', { headers: { 'user-agent': UA }, redirect: 'follow' });
      this.cookie = cookieHeaderFrom(home);
    }

    const params = new URLSearchParams({
      aid: '6383',
      app_name: 'douyin_web',
      live_id: '1',
      device_platform: 'web',
      language: 'zh-CN',
      enter_from: 'web_live',
      cookie_enabled: 'true',
      screen_width: '1920',
      screen_height: '1080',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Chrome',
      browser_version: '134.0.0.0',
      web_rid: this.input,
    });

    const res = await fetch(`https://live.douyin.com/webcast/room/web/enter/?${params}`, {
      headers: {
        'user-agent': UA,
        cookie: this.cookie,
        referer: `https://live.douyin.com/${this.input}`,
      },
    });
    this.cookie = mergeCookies(this.cookie, cookieHeaderFrom(res));

    const body = await res.json().catch(() => null);
    if (!body) throw new Error('抖音房间解析失败：返回不是 JSON（可能被风控）');
    if (body.status_code && body.status_code !== 0) {
      throw new Error(
        `抖音房间解析失败 status_code=${body.status_code}${body?.data?.prompts ? `（${body.data.prompts}）` : ''}`,
      );
    }
    const room = body?.data?.data?.[0] || body?.data?.room;
    if (!room?.id_str) throw new Error('没解析到抖音房间 id，确认房间号正确且正在直播');

    this.roomId = String(room.id_str);
    this.roomStatus = room.status;
    // 主播信息在 data.user（enter 接口的另一层），room.owner 有时为空
    const owner = body?.data?.user || room.owner || {};
    const live = room.status === 2;
    setPlatform('douyin', {
      roomId: this.input,
      title: room.title || '',
      anchor: owner.nickname || '',
      avatar: (owner.avatar_thumb?.url_list?.[0] || imageUrl(owner.avatarThumb)) || '',
      live,
      error: '',
    });
    this.log(
      `[抖音] 房间 ${this.input} → ${this.roomId}，主播 ${owner.nickname || '-'}（${live ? '直播中' : '未开播'}）`,
    );
  }

  connect() {
    if (this.closed) return;
    if (!this.roomId) {
      this.scheduleReconnect();
      return;
    }
    const url = buildWsUrl(this.roomId, this.host);
    this.log('[抖音] 连接弹幕服务器…');
    const ws = new WebSocket(url, {
      headers: {
        Cookie: this.cookie,
        'User-Agent': UA,
        Origin: 'https://live.douyin.com',
        Referer: 'https://live.douyin.com/',
      },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.retry = 0;
      setPlatform('douyin', { status: 'connected', error: '' });
      ws.send(':\x02hb');
      clearInterval(this.hbTimer);
      this.hbTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send(':\x02hb');
      }, 10000);
    });

    ws.on('message', (data) => this.onData(data));

    ws.on('error', (e) => {
      this.log('[抖音] WS 错误', e.message);
      setPlatform('douyin', { status: 'error', error: e.message });
    });

    ws.on('close', () => {
      clearInterval(this.hbTimer);
      if (this.closed) return;
      setPlatform('douyin', { status: 'reconnecting' });
      this.scheduleReconnect();
    });
  }

  onData(data) {
    let frame;
    try {
      frame = pb.pushFrame(data);
    } catch {
      this.frameErrors = (this.frameErrors || 0) + 1;
      if (this.frameErrors <= 3) this.log('[抖音] PushFrame 解析失败');
      return;
    }
    this.frameCount = (this.frameCount || 0) + 1;
    this.lastFrameAt = Date.now();
    if (this.frameCount <= 3) this.log(`[抖音] 收到第 ${this.frameCount} 帧（${data.length} 字节）`);
    if (!frame.payload || !frame.payload.length) return;

    let resp;
    try {
      resp = pb.response(gunzipSync(frame.payload));
    } catch (e) {
      this.gunzipErrors = (this.gunzipErrors || 0) + 1;
      if (this.gunzipErrors <= 3) this.log('[抖音] gzip/Response 解析失败', e.message);
      return;
    }

    // 回 ack，不回服务端就不再推后续消息
    if (resp.needAck && resp.internalExt && this.ws?.readyState === 1) {
      try {
        this.ws.send(this.encodeAck(frame.logId, resp.internalExt));
      } catch {}
    }

    for (const m of resp.messagesList || []) {
      // 首次出现的新消息类型记一笔（不设上限，否则礼物类型会被挤掉）
      if (m.method) {
        if (!this.seenMethods) this.seenMethods = new Set();
        if (!this.seenMethods.has(m.method)) {
          this.seenMethods.add(m.method);
          this.log('[抖音] 消息类型', m.method);
        }
      }
      try {
        this.handle(m);
      } catch (e) {
        this.log('[抖音] 消息解析失败', m.method, e.message);
      }
    }
  }

  /** ack 帧 = PushFrame{ logId:2, payloadType:7 } */
  encodeAck(logId, payloadType) {
    return Buffer.concat([
      varintField(2, Number(logId) || 0),
      lenField(7, Buffer.from(String(payloadType), 'utf8')),
    ]);
  }

  handle(m) {
    recordMethod('douyin', m.method);
    switch (m.method) {
      case 'WebcastChatMessage':
        return this.onChat(m.payload);
      case 'WebcastEmojiChatMessage':
        return this.onEmojiChat(m.payload);
      case 'WebcastGiftMessage':
        return this.onGift(m.payload);
      case 'WebcastMemberMessage':
        return this.onMember(m.payload);
      case 'WebcastLikeMessage':
        return this.onLike(m.payload);
      case 'WebcastSocialMessage':
        return this.onSocial(m.payload);
      case 'WebcastRoomUserSeqMessage':
        return this.onRoomUserSeq(m.payload);
      case 'WebcastControlMessage':
        return this.onControl(m.payload);
      default:
        // 礼物类消息一旦改名，这里留个痕迹；同一种只记一次，别刷屏
        if (/gift/i.test(m.method || '') && !/GiftSort/i.test(m.method)) {
          if (!this.warnedMethods) this.warnedMethods = new Set();
          if (!this.warnedMethods.has(m.method)) {
            this.warnedMethods.add(m.method);
            this.log('[抖音] 未识别的礼物类消息：', m.method);
          }
        }
        return;
    }
  }

  onChat(payload) {
    const c = pb.chat(payload);
    const u = c.user || {};
    const text = (c.content || '').trim();
    if (!text) return;
    push({
      platform: 'douyin',
      kind: 'chat',
      user: {
        id: String(u.id ?? ''),
        name: u.nickname || '匿名观众',
        avatar: imageUrl(u.avatarThumb),
        level: u.fansClub?.data?.level ?? null,
        medal: u.fansClub?.data?.clubName || '',
      },
      text,
    });
  }

  /**
   * 表情弹幕：抖音把它单独放在 WebcastEmojiChatMessage 里。
   * 官方 proto 字段号公开得不全，所以：
   *  - 用户信息按和普通弹幕一致的结构取（1=common / 2=user）
   *  - 图片地址直接在整条 payload 里扫（排除自己头像，避免把头像当表情）
   *  - 扫不到图就退回文字，不会丢消息
   */
  onEmojiChat(payload) {
    let m = {};
    try {
      m = pb.emojiChat(payload);
    } catch {}
    const u = m.user || {};

    const avatar = imageUrl(u.avatarThumb);
    const urls = collectStrings(
      payload,
      (s) => /^https?:\/\/[^\s"'\\]+$/.test(s) && /(douyinpic|byteimg|bytedance|douyincdn)/.test(s),
    );
    const img = urls.find((x) => x !== avatar) || '';

    let text = String(m.defaultContent || '').trim();
    if (!text) {
      const brackets = collectStrings(payload, (s) => /^\[[^\[\]]{1,12}\]$/.test(s));
      text = brackets[0] || '[表情]';
    }

    push({
      platform: 'douyin',
      kind: 'chat',
      user: {
        id: String(u.id ?? ''),
        name: u.nickname || '匿名观众',
        avatar,
        level: u.fansClub?.data?.level ?? null,
        medal: u.fansClub?.data?.clubName || '',
      },
      text,
      emoji: img ? { url: img } : null,
    });
  }

  onGift(payload) {
    const g = pb.gift(payload);
    const u = g.user || {};
    const gift = g.gift || {};
    const count = Number(g.repeatCount ?? 1) || 1;
    const combos = Number(g.comboCount ?? 0) || 0;
    const max = combos > count ? combos : count;
    push({
      platform: 'douyin',
      kind: 'gift',
      // 同一次连击共享 groupId，两次单独赠送 groupId 不同 → 不会被吞
      giftKey: g.groupId
        ? `g${g.groupId}`
        : `${u.id ?? ''}-${g.giftId ?? gift.id ?? gift.name ?? ''}-${Date.now()}`,
      user: {
        id: String(u.id ?? ''),
        name: u.nickname || '匿名观众',
        avatar: imageUrl(u.avatarThumb),
      },
      gift: {
        name: gift.name || '礼物',
        count: max,
        unitPrice: Number(gift.diamondCount ?? 0),
        coinType: 'diamond',
        describe: gift.describe || '',
        image: imageUrl(gift.image) || imageUrl(gift.icon),
      },
    });
  }

  onMember(payload) {
    const m = pb.member(payload);
    const u = m.user || {};
    push({
      platform: 'douyin',
      kind: 'enter',
      user: { id: String(u.id ?? ''), name: u.nickname || '匿名观众', avatar: imageUrl(u.avatarThumb) },
      text: '进入了直播间',
    });
  }

  onLike(payload) {
    const m = pb.like(payload);
    const u = m.user || {};
    this.likeBuffer += Number(m.count ?? 1) || 1;
    clearTimeout(this.likeTimer);
    this.likeTimer = setTimeout(() => {
      const total = this.likeBuffer;
      this.likeBuffer = 0;
      if (!total) return;
      push({
        platform: 'douyin',
        kind: 'like',
        user: { id: String(u.id ?? ''), name: u.nickname || '匿名观众', avatar: imageUrl(u.avatarThumb) },
        text: `为主播点了 ${total} 个赞`,
      });
    }, 1200);
  }

  onSocial(payload) {
    const m = pb.social(payload);
    const u = m.user || {};
    // action: 1 = 关注
    if (Number(m.action) !== 1) return;
    push({
      platform: 'douyin',
      kind: 'follow',
      user: { id: String(u.id ?? ''), name: u.nickname || '匿名观众', avatar: imageUrl(u.avatarThumb) },
      text: '关注了主播',
    });
  }

  onRoomUserSeq(payload) {
    const m = pb.roomUserSeq(payload);
    const n = Number(m.total ?? 0) || 0;
    setPlatform('douyin', { online: n });
  }

  onControl(payload) {
    const m = pb.control(payload);
    if (Number(m.status) === 3) setPlatform('douyin', { live: false });
  }

  scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    this.retry = Math.min(this.retry + 1, 8);
    const wait = Math.min(1000 * 2 ** this.retry, 30000);
    setPlatform('douyin', { status: 'reconnecting' });
    this.log(`[抖音] ${Math.round(wait / 1000)}s 后重连（第 ${this.retry} 次）`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.resolveRoom();
        this.connect();
      } catch (e) {
        setPlatform('douyin', { status: 'error', error: String(e.message || e) });
        this.scheduleReconnect();
      }
    }, wait);
  }
}

/* --- 最小 protobuf 编码，仅用于回 ack --- */

function encodeVarint(value) {
  const bytes = [];
  let n = BigInt(Math.trunc(Number(value) || 0));
  if (n < 0n) n += 1n << 64n;
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

/** 变长整数字段（wire type 0） */
function varintField(fieldId, value) {
  return Buffer.concat([Buffer.from([(fieldId << 3) | 0]), encodeVarint(value)]);
}

/** 长度分隔字段（wire type 2），用于 string / bytes / 嵌套消息 */
function lenField(fieldId, payload) {
  return Buffer.concat([Buffer.from([(fieldId << 3) | 2]), encodeVarint(payload.length), payload]);
}
