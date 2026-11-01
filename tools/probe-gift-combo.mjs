// 抓 B 站真实礼物，确认「连击」和「两次单独赠送」在数据上怎么区分
import { BilibiliSource } from '../server/platforms/bilibili.js';
import { decodeGiftV2 } from '../server/platforms/bilibili-pb.js';

const room = process.argv[2] || '6';
const DUR = Number(process.argv[3] || 150000);

const src = new BilibiliSource({ roomId: room, cookie: '' }, { log: () => {} });
const gifts = [];

const orig = src.handle.bind(src);
src.handle = (msg) => {
  if (msg.cmd === 'SEND_GIFT_V2') {
    try {
      const g = decodeGiftV2(msg.data.pb);
      gifts.push({
        t: Date.now(),
        uid: String(g.uid),
        name: g.giftName,
        num: g.num,
        combo: g.comboId,
        price: g.price,
      });
    } catch {}
  }
  return orig(msg);
};

src.start();

setTimeout(() => {
  console.log(`\n=== 抓到 ${gifts.length} 条礼物 ===`);
  for (const g of gifts.slice(0, 25)) {
    const comboShort = g.combo ? String(g.combo).slice(-28) : '(空)';
    console.log(`  uid=${g.uid.padEnd(10)} ${g.name} num=${String(g.num).padEnd(3)} 价格=${g.price} combo=…${comboShort}`);
  }

  // 按 batch_combo_id 分组，看同一组里 num 是不是递增
  const byCombo = new Map();
  for (const g of gifts) {
    const k = g.combo || '(空)';
    if (!byCombo.has(k)) byCombo.set(k, []);
    byCombo.get(k).push(g);
  }
  console.log('\n=== 分组情况 ===');
  let combosWithMulti = 0;
  for (const [k, list] of byCombo) {
    if (list.length > 1) {
      combosWithMulti++;
      if (combosWithMulti <= 5) {
        console.log(`  同 combo ${String(k).slice(-24)} → ${list.length} 条, num = ${list.map((x) => x.num).join(',')}`);
      }
    }
  }
  console.log(`  出现多条共享同一 combo 的组数: ${combosWithMulti}`);

  // 同一个人同一礼物，combo 是否不同
  const byUserGift = new Map();
  for (const g of gifts) {
    const k = `${g.uid}|${g.name}`;
    if (!byUserGift.has(k)) byUserGift.set(k, new Set());
    byUserGift.get(k).add(g.combo || '(空)');
  }
  let diffCombo = 0;
  for (const [k, set] of byUserGift) {
    if (set.size > 1) {
      diffCombo++;
      if (diffCombo <= 5) console.log(`  同一人同一礼物 ${k} 出现了 ${set.size} 个不同 combo`);
    }
  }
  console.log(`  同一人同一礼物对应多个 combo 的组数: ${diffCombo}`);

  src.stop();
  process.exit(0);
}, DUR);
