// 验证礼物合并规则：
//  - 同一次连击（同一个 key）→ 原地累加，不刷屏
//  - 两次单独赠送（不同 key）→ 两行，不能吞
//  - 连击数字两种下发方式（逐次递增 / 每次都是 1）都要算对
//  - 关掉「礼物连击合并」后，每条礼物都单独一行
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, requireJSDOM } from './_lib.mjs';

const { JSDOM } = requireJSDOM();

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ mergeGiftCombo = true, gifts }) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:7801/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.CSS = { escape: (s) => String(s) };
  window.fetch = async () => ({
    ok: true,
    json: async () => ({
      config: {
        rooms: { bilibili: { roomId: '1' } },
        display: { maxDanmaku: 50, maxGifts: 20, mergeGiftCombo, showHeader: true },
      },
      state: { platforms: { bilibili: { id: 'bilibili', status: 'connected' } } },
    }),
  });

  let sock = null;
  window.WebSocket = class {
    constructor() {
      sock = this;
      this.readyState = 1;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }
    send() {}
    close() {}
    emit(o) {
      this.onmessage && this.onmessage({ data: JSON.stringify(o) });
    }
  };

  window.eval(appJs);
  await wait(50);
  const doc = window.document;
  sock.emit({ type: 'hello', state: { platforms: { bilibili: { id: 'bilibili', status: 'connected' } } }, emoji: {}, recent: [] });
  await wait(20);

  for (const [giftKey, count] of gifts) {
    sock.emit({
      type: 'message',
      message: {
        id: 'g' + Math.random(),
        platform: 'bilibili',
        kind: 'gift',
        giftKey,
        user: { id: 'u1', name: '观众A', avatar: '' },
        gift: { name: '粉丝团灯牌', count, unitPrice: 100, coinType: 'gold' },
      },
    });
    await wait(6);
  }
  await wait(30);

  const rows = [...doc.getElementById('giftStream').children].filter((n) => n.classList.contains('gift'));
  return { rows: rows.length, counts: rows.map((r) => r.querySelector('.gift-count')?.textContent) };
}

const checks = [];

// 1) 默认（合并开）
const a = await run({
  gifts: [
    ['combo-A', 1],
    ['combo-A', 1], // 同一次连击，每次下发 1 → ×2
    ['combo-B', 1],
    ['combo-C', 1], // 两次单独赠送 → 两行
    ['combo-D', 1],
    ['combo-D', 2],
    ['combo-D', 3], // 递增式连击 → ×3
  ],
});
checks.push(['两次单独赠送没有被吞（共 4 行）', a.rows === 4, `实际 ${a.rows}`]);
checks.push(['同一次连击累加到 ×2', a.counts[0] === '×2', a.counts[0]]);
checks.push(['单独赠送各自一行（第 2 行 ×1）', a.counts[1] === '×1', a.counts[1]]);
checks.push(['单独赠送各自一行（第 3 行 ×1）', a.counts[2] === '×1', a.counts[2]]);
checks.push(['递增式连击显示最终数量 ×3', a.counts[3] === '×3', a.counts[3]]);

// 2) 关掉合并：同一次连击也各占一行
const b = await run({ mergeGiftCombo: false, gifts: [['combo-A', 1], ['combo-A', 1], ['combo-B', 1]] });
checks.push(['关掉合并后每条礼物都独立成行（3 行）', b.rows === 3, `实际 ${b.rows}`]);

let pass = 0;
for (const [n, ok, extra] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
