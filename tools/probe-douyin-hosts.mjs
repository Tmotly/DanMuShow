// 同时连多个抖音弹幕节点，比对它们各自推送哪些消息类型（找礼物事件）
import { DouyinSource } from '../server/platforms/douyin.js';

const webRid = process.argv[2] || '644847292813';
const DUR = Number(process.argv[3] || 150000);
const HOSTS = ['webcast100-ws-web-hl.douyin.com', 'webcast5-ws-web-lf.douyin.com', 'webcast5-ws-web-lq.douyin.com'];

const results = new Map(HOSTS.map((h) => [h, { counts: new Map(), ok: false, err: '' }]));

for (const host of HOSTS) {
  const rec = results.get(host);
  const src = new DouyinSource({ roomId: webRid, cookie: '' }, { log: () => {}, host });
  const orig = src.handle.bind(src);
  src.handle = (m) => {
    const k = m.method || '(空)';
    rec.counts.set(k, (rec.counts.get(k) || 0) + 1);
    rec.ok = true;
    return orig(m);
  };
  src.onWsError = () => {};
  src.start();
}

setTimeout(() => {
  for (const host of HOSTS) {
    const { counts, ok, err } = results.get(host);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const giftish = [...counts.entries()].filter(([k]) => /gift/i.test(k));
    console.log(`\n=== ${host} ===`);
    console.log(`  收到消息 ${total} 条 / ${counts.size} 种  ${ok ? '' : '(疑似没连上)'}`);
    if (giftish.length) {
      for (const [k, v] of giftish) console.log(`  礼物类: ${k} ×${v}`);
    } else {
      console.log('  礼物类: 无');
    }
  }
  const anyGiftMsg = HOSTS.some((h) => [...results.get(h).counts.keys()].includes('WebcastGiftMessage'));
  console.log(`\n结论：${anyGiftMsg ? '有节点推了 WebcastGiftMessage' : '所有节点都没有 WebcastGiftMessage'}`);
  process.exit(0);
}, DUR);
