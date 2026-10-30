/**
 * 极简 protobuf 解码器（按 wire format 通用解析，schema 驱动）。
 *
 * 为什么不用现成的 .proto 生成产物：
 * 1) 网上流传的 douyin.proto 静态产物里 Image 的 1 号字段（头像 URL 列表）被裁掉了；
 * 2) B 站 SEND_GIFT_V2 的礼物数据是塞在 base64 的裸 protobuf 里，没有公开 .proto。
 * 自己按 wire format 解析 + 手写 schema，字段号都是从真实数据里核对出来的。
 */

const WT = { VARINT: 0, I64: 1, LEN: 2, I32: 5 };

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, p];
    shift += 7n;
    if (shift > 70n) throw new Error('varint overflow');
  }
  throw new Error('varint truncated');
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
const toStr = (b) => utf8.decode(b);
const toNum = (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());

/** 把 buffer 解析成 Map<字段号, [{wt, v}]> */
export function parseFields(buf) {
  const out = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const [tagBig, p1] = readVarint(buf, pos);
    const tag = Number(tagBig);
    const fieldId = tag >>> 3;
    const wt = tag & 7;
    pos = p1;

    let value;
    if (wt === WT.VARINT) {
      const [v, p2] = readVarint(buf, pos);
      value = v;
      pos = p2;
    } else if (wt === WT.I64) {
      if (pos + 8 > buf.length) throw new Error('truncated i64');
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wt === WT.LEN) {
      const [lenBig, p2] = readVarint(buf, pos);
      const len = Number(lenBig);
      if (p2 + len > buf.length) throw new Error('truncated len');
      value = buf.subarray(p2, p2 + len);
      pos = p2 + len;
    } else if (wt === WT.I32) {
      if (pos + 4 > buf.length) throw new Error('truncated i32');
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new Error('unsupported wire type ' + wt);
    }

    let arr = out.get(fieldId);
    if (!arr) out.set(fieldId, (arr = []));
    arr.push({ wt, v: value });
  }
  return out;
}

/**
 * schema 形如 { 1: ['common', 'Common'], 2: ['content', 's'] }
 * 类型：'s' 字符串 / 'u' 无符号 varint / 'i' 有符号 varint / 'b' 原始字节 / 'bool' / 其他=嵌套消息名
 * 第三项为 true 表示 repeated。
 */
export function decode(buf, schema, typeName) {
  const spec = schema[typeName];
  if (!spec) throw new Error('no schema for ' + typeName);
  const fields = parseFields(buf);
  const obj = {};
  for (const [idStr, defn] of Object.entries(spec)) {
    const list = fields.get(Number(idStr));
    if (!list || !list.length) continue;
    const [prop, kind, repeated] = defn;
    const vals = [];
    for (const { wt, v } of list) {
      let decoded;
      if (kind === 's') {
        decoded = wt === WT.LEN ? toStr(v) : String(v);
      } else if (kind === 'u') {
        decoded = wt === WT.VARINT ? toNum(v) : 0;
      } else if (kind === 'i') {
        if (wt === WT.VARINT) {
          let n = v;
          if (n >= 1n << 63n) n -= 1n << 64n;
          const num = Number(n);
          decoded = Number.isSafeInteger(num) ? num : n.toString();
        } else decoded = 0;
      } else if (kind === 'bool') {
        decoded = wt === WT.VARINT ? v !== 0n : false;
      } else if (kind === 'b') {
        decoded = v;
      } else {
        decoded = wt === WT.LEN ? decode(v, schema, kind) : null;
      }
      if (decoded !== null && decoded !== undefined) vals.push(decoded);
    }
    if (!vals.length) continue;
    obj[prop] = repeated ? vals : vals[vals.length - 1];
  }
  return obj;
}

/**
 * 在一段 protobuf 字节里递归找满足条件的字符串。
 *
 * 用途：结构不确定的消息（比如抖音的表情弹幕，官方 proto 都不全），
 * 与其赌字段号，不如扫出来兜底。payload 都很小，开销可以忽略。
 */
export function collectStrings(buf, predicate, maxDepth = 6) {
  const out = [];
  const walk = (node, depth) => {
    let fields;
    try {
      fields = parseFields(node);
    } catch {
      return;
    }
    for (const list of fields.values()) {
      for (const { wt, v } of list) {
        if (wt !== WT.LEN || !v || !v.length) continue;
        const s = toStr(v);
        if (predicate(s)) out.push(s);
        else if (depth < maxDepth) walk(v, depth + 1);
      }
    }
  };
  walk(buf, 0);
  return out;
}
