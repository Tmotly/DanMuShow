// 构造真实的 Douyin PushFrame（gzip + protobuf），走一遍 DouyinSource.onData，
// 验证「弹幕 / 礼物」能不能被解出来。不依赖真实房间。
import zlib from 'node:zlib';
import { DouyinSource } from '../server/platforms/douyin.js';
import { onMessage, state } from '../server/hub.js';

/* ---- 最小 protobuf 编码器 ---- */
function varint(v) {
  let n = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)));
  if (n < 0n) n += 1n << 64n;
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}
const tag = (id, wt) => varint(BigInt((id << 3) | wt));
const fVarint = (id, v) => Buffer.concat([tag(id, 0), varint(v)]);
const fBytes = (id, buf) => Buffer.concat([tag(id, 2), varint(BigInt(buf.length)), buf]);
const fStr = (id, s) => fBytes(id, Buffer.from(s, 'utf8'));

/* ---- 造一帧 ---- */
function makeFrame(messages) {
  const response = Buffer.concat(messages.map((m) => fBytes(1, m)));
  const payload = zlib.gzipSync(response);
  return Buffer.concat([
    fVarint(1, 1), // seqId
    fVarint(2, 6576506577139586187n), // logId
    fStr(6, 'gzip'), // payloadEncoding
    fBytes(8, payload),
  ]);
}

function makeMessage(method, payload) {
  return Buffer.concat([fStr(1, method), fBytes(2, payload)]);
}

/* ---- 用户 & 头像 ---- */
const avatarImg = fStr(1, 'https://p3.douyinpic.com/aweme/100x100/avatar.jpeg'); // Image.urlListList[0]
const user = Buffer.concat([
  fVarint(1, 777000111n), // id
  fStr(3, '抖音小明'), // nickname
  fBytes(9, avatarImg), // avatarThumb
]);
const common = Buffer.concat([fVarint(3, 7702500747056827163n), fVarint(4, 1793400000)]);

/* ---- 弹幕 ---- */
const chatPayload = Buffer.concat([fBytes(1, common), fBytes(2, user), fStr(3, '抖音发来的弹幕内容')]);

/* ---- 礼物 ---- */
const giftStruct = Buffer.concat([fStr(2, '玫瑰'), fVarint(12, 10), fStr(16, '玫瑰')]);
const giftPayload = Buffer.concat([
  fBytes(1, common),
  fVarint(2, 12345), // giftId
  fVarint(5, 1), // repeatCount
  fVarint(6, 3), // comboCount
  fBytes(7, user), // user
  fBytes(15, giftStruct), // gift
]);

/* ---- 跑 ---- */
const got = [];
/* ---- 表情弹幕 ---- */
const EMOJI_IMG = 'https://p3.douyinpic.com/obj/emoji/bitheart.png';
const emojiPayload = Buffer.concat([
  fBytes(1, common),
  fBytes(2, user),
  fStr(5, '[比心]'),
  fStr(9, EMOJI_IMG),
]);

onMessage((m) => got.push(m));

const src = new DouyinSource({ roomId: '0', cookie: '' }, { log: () => {} });

const frame = makeFrame([
  makeMessage('WebcastChatMessage', chatPayload),
  makeMessage('WebcastGiftMessage', giftPayload),
  makeMessage('WebcastEmojiChatMessage', emojiPayload),
]);
src.onData(frame);

const checks = [];
const check = (n, ok, extra = '') => checks.push({ n, ok, extra });

const chat = got.find((m) => m.kind === 'chat' && !m.emoji);
const emojiChat = got.find((m) => m.kind === 'chat' && m.emoji?.url);
const gift = got.find((m) => m.kind === 'gift');

check('解析出弹幕', !!chat);
check('弹幕内容正确', chat?.text === '抖音发来的弹幕内容', chat?.text);
check('弹幕昵称正确', chat?.user?.name === '抖音小明', chat?.user?.name);
check('弹幕头像拿到', String(chat?.user?.avatar || '').includes('douyinpic'), chat?.user?.avatar);
check('弹幕 uid 正确', String(chat?.user?.id) === '777000111', String(chat?.user?.id));

check('解析出表情弹幕', !!emojiChat);
check('表情图地址正确（没有误抓头像）', emojiChat?.emoji?.url === EMOJI_IMG, emojiChat?.emoji?.url);
check('表情弹幕保留文字兜底', emojiChat?.text === '[比心]', emojiChat?.text);
check('表情弹幕昵称正确', emojiChat?.user?.name === '抖音小明', emojiChat?.user?.name);

check('解析出礼物', !!gift);
check('礼物名正确', gift?.gift?.name === '玫瑰', gift?.gift?.name);
check('礼物数量取自连击数', gift?.gift?.count === 3, JSON.stringify(gift?.gift?.count));
check('礼物单价正确', gift?.gift?.unitPrice === 10, JSON.stringify(gift?.gift?.unitPrice));
check('礼物头像拿到', String(gift?.user?.avatar || '').includes('douyinpic'));
check('礼物有合并 key', !!gift?.giftKey, gift?.giftKey);
check('记录了收到的消息类型', !!state.platforms.douyin.methods?.WebcastChatMessage,
  JSON.stringify(state.platforms.douyin.methods || {}));
check('礼物类型也被记录', !!state.platforms.douyin.methods?.WebcastGiftMessage);

let pass = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.n}${c.extra ? ' — ' + c.extra : ''}`);
  if (c.ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
