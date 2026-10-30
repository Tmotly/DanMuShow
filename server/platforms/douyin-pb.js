/**
 * 抖音 webcast 的 protobuf 结构定义。
 *
 * 解码器在 ../lib/pb.js（通用 wire format 解析）。
 * 字段号来自对官方静态生成物 encode() 的逐字段核对。
 *
 * 注意 Image 的第 1 号字段：那是头像/礼物图的 URL 列表。
 * 网上流传的 douyin.proto 静态产物把这个字段裁掉了，直接用会导致头像永远为空，
 * 所以这里补了回来。
 */
import { decode } from '../lib/pb.js';

export const SCHEMA = {
  PushFrame: {
    1: ['seqId', 'u'],
    2: ['logId', 'u'],
    6: ['payloadEncoding', 's'],
    7: ['payloadType', 's'],
    8: ['payload', 'b'],
  },
  Response: {
    1: ['messagesList', 'Message', true],
    2: ['cursor', 's'],
    5: ['internalExt', 's'],
    8: ['heartbeatDuration', 'u'],
    9: ['needAck', 'bool'],
  },
  Message: {
    1: ['method', 's'],
    2: ['payload', 'b'],
  },
  Common: {
    3: ['roomId', 'u'],
    4: ['createTime', 'u'],
    7: ['describe', 's'],
  },
  ChatMessage: {
    1: ['common', 'Common'],
    2: ['user', 'User'],
    3: ['content', 's'],
  },
  // 抖音的表情弹幕是独立消息，字段号官方没公开全，这里只取能确定的部分，
  // 图片地址在 douyin.js 里用 collectStrings 扫出来兜底
  EmojiChatMessage: {
    1: ['common', 'Common'],
    2: ['user', 'User'],
    5: ['defaultContent', 's'],
  },
  GiftMessage: {
    1: ['common', 'Common'],
    2: ['giftId', 'u'],
    5: ['repeatCount', 'u'],
    6: ['comboCount', 'u'],
    7: ['user', 'User'],
    9: ['repeatEnd', 'u'],
    11: ['groupId', 'u'],
    15: ['gift', 'GiftStruct'],
    29: ['totalCount', 'u'],
  },
  GiftStruct: {
    1: ['image', 'Image'],
    2: ['describe', 's'],
    5: ['id', 'u'],
    12: ['diamondCount', 'u'],
    16: ['name', 's'],
    21: ['icon', 'Image'],
  },
  User: {
    1: ['id', 'u'],
    3: ['nickname', 's'],
    9: ['avatarThumb', 'Image'],
    21: ['badgeImages', 'Image', true],
    24: ['fansClub', 'FansClub'],
  },
  // 第 1 号字段 = 图片 URL 列表（官方产物里被裁掉了，这里补回）
  Image: {
    1: ['urlList', 's', true],
    2: ['uri', 's'],
  },
  FansClub: {
    1: ['data', 'FansClubData'],
  },
  FansClubData: {
    1: ['clubName', 's'],
    2: ['level', 'u'],
  },
  MemberMessage: {
    1: ['common', 'Common'],
    2: ['user', 'User'],
    3: ['memberCount', 'u'],
    10: ['action', 'u'],
    11: ['actionDescription', 's'],
  },
  LikeMessage: {
    1: ['common', 'Common'],
    2: ['count', 'u'],
    3: ['total', 'u'],
    5: ['user', 'User'],
  },
  SocialMessage: {
    1: ['common', 'Common'],
    2: ['user', 'User'],
    3: ['shareType', 'u'],
    4: ['action', 'u'],
    6: ['followCount', 'u'],
  },
  RoomUserSeqMessage: {
    3: ['total', 'i'],
    4: ['popStr', 's'],
    7: ['totalUser', 'i'],
    8: ['totalUserStr', 's'],
  },
  ControlMessage: {
    1: ['common', 'Common'],
    2: ['status', 'i'],
  },
  RoomMessage: {
    1: ['common', 'Common'],
    2: ['content', 's'],
  },
};

export const pb = {
  pushFrame: (buf) => decode(buf, SCHEMA, 'PushFrame'),
  response: (buf) => decode(buf, SCHEMA, 'Response'),
  message: (buf) => decode(buf, SCHEMA, 'Message'),
  chat: (buf) => decode(buf, SCHEMA, 'ChatMessage'),
  emojiChat: (buf) => decode(buf, SCHEMA, 'EmojiChatMessage'),
  gift: (buf) => decode(buf, SCHEMA, 'GiftMessage'),
  member: (buf) => decode(buf, SCHEMA, 'MemberMessage'),
  like: (buf) => decode(buf, SCHEMA, 'LikeMessage'),
  social: (buf) => decode(buf, SCHEMA, 'SocialMessage'),
  roomUserSeq: (buf) => decode(buf, SCHEMA, 'RoomUserSeqMessage'),
  control: (buf) => decode(buf, SCHEMA, 'ControlMessage'),
  room: (buf) => decode(buf, SCHEMA, 'RoomMessage'),
};

/** 从 Image 结构里取第一个可用地址 */
export function imageUrl(img) {
  if (!img) return '';
  const list = img.urlList || [];
  return list.find((u) => typeof u === 'string' && u.startsWith('http')) || '';
}
