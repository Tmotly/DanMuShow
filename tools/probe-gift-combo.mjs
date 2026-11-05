// 重点验证两件事：
//  A. 真连击会不会出现「多条消息共享同一 combo id」
//  B. 同一个用户短时间内连送同一礼物时，combo id 是否不同（这正是被吞的场景）
import { BilibiliSource } from '../server/platforms/bilibili.js';
import { decodeGiftV2 } from '../server/platforms/bilibili-pb.js';

const room = process.argv[2] || '6';
const DUR = Number(process.argv[3] || 180000);

const src = new BilibiliSource({ roomId: room, cookie: '' }, { log: () => {} });
const gifts = [];

const orig = src.handle.bind(src);
src.handle = (msg) => {
  if (msg.cmd === 'SEND_GIFT_V2') {
    try {
      const g = decodeGiftV2(msg.data.pb);
      gifts.push({
        t: Date.now(),
        who: g.uname || '(空)',
        uid: String(g.uid || ''),
        gift: g.giftName,
        num: g.num,
        combo: String(g.comboId || ''),
      });
    } catch {}
  }
  return orig(msg);
};
src.start();

setTimeout(() => {
  console.log(`\n=== 共 ${gifts.length} 条礼物 ===`);

  // A. 共享同一 combo id 的组（真连击）
  const byCombo = new Map();
  for (const g of gifts) {
    const k = g.combo || '(空)';
    if (!byCombo.has(k)) byCombo.set(k, []);
    byCombo.get(k).push(g);
  }
  const combos = [...byCombo.values()].filter((l) => l.length > 1);
  console.log(`A. 共享同一 combo id 的组数：${combos.length}`);
  for (const l of combos.slice(0, 3)) {
    console.log(`   同 combo ${l.length} 条, num=${l.map((x) => x.num).join(',')}, ${l[0].who} 送 ${l[0].gift}`);
  }

  // B. 同一「人+礼物」在 8 秒内出现多次，combo id 是否不同
  let pairs = 0;
  let diffCombo = 0;
  for (let i = 0; i < gifts.length; i++) {
    for (let j = i + 1; j < gifts.length; j++) {
      const a = gifts[i];
      const b = gifts[j];
      if (a.who !== b.who || a.gift !== b.gift) continue;
      if (b.t - a.t > 8000) break;
      pairs++;
      if (a.combo !== b.combo) diffCombo++;
      if (pairs <= 5) {
        console.log(`B. ${a.who} 连送 ${a.gift}，间隔 ${b.t - a.t}ms，combo 相同? ${a.combo === b.combo}`);
      }
    }
  }
  console.log(`B. 同一人同一礼物 8 秒内出现 ${pairs} 对，combo 不同的 ${diffCombo} 对`);

  // C. 昵称重复出现（不区分 uid，掩码用户也能看出是同一个人）
  const byWho = new Map();
  for (const g of gifts) byWho.set(g.who, (byWho.get(g.who) || 0) + 1);
  const repeat = [...byWho.entries()].filter(([, n]) => n > 1).slice(0, 5);
  console.log(`C. 出现多次的昵称：${repeat.map(([w, n]) => `${w}×${n}`).join(', ') || '(无)'}`);

  src.stop();
  process.exit(0);
}, DUR);
