// 连一个真实在播的抖音房间，统计所有消息类型，重点找礼物
import { DouyinSource } from '../server/platforms/douyin.js';

const webRid = process.argv[2] || '644847292813';
const DUR = Number(process.argv[3] || 180000);

const counts = new Map();
const dumps = [];
const chats = [];

const src = new DouyinSource({ roomId: webRid, cookie: '' }, { log: (...a) => console.log('[src]', ...a) });

const orig = src.handle.bind(src);
src.handle = (m) => {
  const k = m.method || '(空)';
  counts.set(k, (counts.get(k) || 0) + 1);
  if (k === 'WebcastChatMessage') {
    try {
      const c = src.constructor; // 仅用于说明
      if (chats.length < 3) chats.push(m.payload.length);
    } catch {}
  }
  // 名字里带 Gift 但不是排序消息 → 可能是真礼物，把原始长度记下来
  if (/gift/i.test(k) && !/GiftSort/.test(k)) {
    dumps.push({ k, len: m.payload?.length || 0 });
  }
  return orig(m);
};

src.start();

setTimeout(() => {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n=== ${DUR / 1000}s 内收到的消息类型（共 ${sorted.length} 种）===`);
  for (const [k, v] of sorted) console.log(`  ${String(v).padStart(5)}  ${k}`);

  console.log('\n=== 名字带 Gift 的非排序消息 ===');
  if (!dumps.length) console.log('  （没有）');
  for (const d of dumps.slice(0, 10)) console.log(`  ${d.k} payload ${d.len} 字节`);

  const hasGift = [...counts.keys()].some((k) => k === 'WebcastGiftMessage');
  console.log(`\n有 WebcastGiftMessage 吗：${hasGift ? '有' : '没有'}`);

  src.stop();
  process.exit(0);
}, DUR);
