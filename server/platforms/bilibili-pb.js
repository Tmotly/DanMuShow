/**
 * B 站 SEND_GIFT_V2 的解码。
 *
 * 现在 B 站网页端下发的礼物消息是 SEND_GIFT_V2，结构是：
 *   { dmscore: <number>, pb: "<base64 的 protobuf>" }
 * 老的 SEND_GIFT 带明文 JSON 字段，已经基本不发了。
 *
 * 下面的字段号是从真实礼物数据里逐条核对出来的（不是猜的）：
 *   顶层  1=uid  2=昵称  3=头像  8=粉丝牌{5 等级, 6 牌子名}
 *         10=礼物详情
 *   礼物  1=礼物id 2=礼物名 3=数量 5=单价 8=币种 12=连击批次 18=动作文案
 *         35=礼物图片{1,2,5=图片地址}
 */
import { decode, parseFields } from '../lib/pb.js';

export const GIFT_V2_SCHEMA = {
  GiftV2: {
    1: ['uid', 'u'],
    2: ['uname', 's'],
    3: ['face', 's'],
    8: ['medal', 'GiftMedal'],
    10: ['gift', 'GiftDetail'],
  },
  GiftMedal: {
    5: ['level', 'u'],
    6: ['name', 's'],
  },
  GiftDetail: {
    1: ['id', 'u'],
    2: ['name', 's'],
    3: ['num', 'u'],
    5: ['price', 'u'],
    8: ['coinType', 's'],
    12: ['batchComboId', 's'],
    18: ['action', 's'],
    35: ['images', 'GiftImages'],
  },
  GiftImages: {
    1: ['webp', 's'],
    2: ['png', 's'],
    5: ['gif', 's'],
  },
};

const utf8 = new TextDecoder('utf-8', { fatal: false });

/** 顶层只取标量字段，避免把大块嵌套结构整个解出来 */
function quickTop(buf) {
  const fields = parseFields(buf);
  const pick = (id) => {
    const list = fields.get(id);
    if (!list || !list.length) return '';
    const { wt, v } = list[list.length - 1];
    return wt === 2 ? utf8.decode(v) : String(v);
  };
  return {
    uid: pick(1),
    uname: pick(2),
    face: pick(3),
  };
}

/**
 * 解一条 SEND_GIFT_V2
 * @param {string} b64 data.pb
 */
export function decodeGiftV2(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const top = quickTop(buf);
  let g = {};
  try {
    g = decode(buf, GIFT_V2_SCHEMA, 'GiftV2');
  } catch {
    g = {};
  }
  const detail = g.gift || {};
  const medal = g.medal || {};
  const images = detail.images || {};

  return {
    uid: top.uid || (g.uid != null ? String(g.uid) : ''),
    uname: top.uname || g.uname || '',
    face: top.face || g.face || '',
    medalName: medal.name || '',
    medalLevel: medal.level || 0,
    giftId: detail.id,
    giftName: detail.name || '礼物',
    num: Number(detail.num ?? 1) || 1,
    price: Number(detail.price ?? 0) || 0,
    coinType: detail.coinType || 'gold',
    comboId: detail.batchComboId || '',
    action: detail.action || '',
    image: images.webp || images.png || images.gif || '',
  };
}
