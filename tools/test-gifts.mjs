// 并行盯多个热门房间，只关心「礼物能不能解出来」
import { BilibiliSource } from '../server/platforms/bilibili.js';
import { onMessage } from '../server/hub.js';

const ROOMS = ['5050', '22637261', '1017', '21452505'];
const DUR = Number(process.argv[2] || 150000);

const perRoom = {};
let v2 = 0;
let legacy = 0;

onMessage((m) => {
  if (m.kind !== 'gift' && m.kind !== 'superchat') return;
  const k = m.platform;
  perRoom[k] = (perRoom[k] || 0) + 1;
  if (m.kind === 'superchat') {
    console.log('  ⭐ 醒目留言:', m.user?.name, m.text?.slice(0, 20), '¥' + m.gift?.unitPrice);
    return;
  }
  console.log(
    '  🎁',
    m.user?.name,
    '送',
    m.gift?.name,
    '×' + m.gift?.count,
    '| 单价',
    m.gift?.unitPrice,
    m.gift?.coinType,
    '| 有图',
    m.gift?.image ? 'Y' : 'N',
    '| 头像',
    m.user?.avatar ? 'Y' : 'N',
  );
});

const sources = ROOMS.map((r) => new BilibiliSource({ roomId: r, cookie: '' }, { log: () => {} }));
const counts = {};
for (let i = 0; i < ROOMS.length; i++) {
  const src = sources[i];
  const room = ROOMS[i];
  counts[room] = { v2: 0, old: 0 };
  const orig = src.handle.bind(src);
  src.handle = (msg) => {
    if (msg.cmd === 'SEND_GIFT_V2') counts[room].v2++;
    if (msg.cmd === 'SEND_GIFT') counts[room].old++;
    return orig(msg);
  };
  src.start();
}

setTimeout(() => {
  console.log('\n=== 各房间礼物消息数 ===');
  for (const [room, c] of Object.entries(counts)) console.log(` ${room}: SEND_GIFT_V2=${c.v2}, SEND_GIFT=${c.old}`);
  console.log('归一化后的礼物事件总数:', Object.values(perRoom).reduce((a, b) => a + b, 0));
  sources.forEach((s) => s.stop());
  process.exit(0);
}, DUR);
