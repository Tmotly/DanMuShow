// 验证礼物合并规则：
//  - 同一次连击（同一个 key）→ 原地累加，不刷屏
//  - 两次单独赠送（不同 key）→ 两行，不能吞
//  - 连击数字两种下发方式（逐次递增 / 每次都是 1）都要算对
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, requireJSDOM } from './_lib.mjs';

const { JSDOM } = requireJSDOM();

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const dom = new JSDOM(html, { url: 'http://127.0.0.1:7801/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.CSS = { escape: (s) => String(s) };
window.fetch = async () => ({
  ok: true,
  json: async () => ({
    config: { rooms: { bilibili: { roomId: '1' } }, display: { maxDanmaku: 50, maxGifts: 20, showHeader: true } },
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(50);

const doc = window.document;
const giftStream = doc.getElementById('giftStream');

sock.emit({ type: 'hello', state: { platforms: { bilibili: { id: 'bilibili', status: 'connected' } } }, emoji: {}, recent: [] });
await wait(20);

let seq = 0;
const sendGift = (giftKey, count) =>
  sock.emit({
    type: 'message',
    message: {
      id: 'g' + ++seq,
      platform: 'bilibili',
      kind: 'gift',
      giftKey,
      user: { id: 'u1', name: '观众A', avatar: '' },
      gift: { name: '粉丝团灯牌', count, unitPrice: 100, coinType: 'gold' },
    },
  });

// 1) 同一次连击：每次下发 num=1
sendGift('combo-A', 1);
await wait(5);
sendGift('combo-A', 1);
await wait(20);

// 2) 两次单独赠送：combo id 不同（B站真实情况）
sendGift('combo-B', 1);
await wait(5);
sendGift('combo-C', 1);
await wait(20);

// 3) 递增式连击：1,2,3
sendGift('combo-D', 1);
await wait(5);
sendGift('combo-D', 2);
await wait(5);
sendGift('combo-D', 3);
await wait(20);

const rows = [...giftStream.children].filter((n) => n.classList.contains('gift'));
const countOf = (i) => rows[i]?.querySelector('.gift-count')?.textContent;

const checks = [
  ['两次单独赠送没有被吞（共 4 行）', rows.length === 4, `实际 ${rows.length}`],
  ['同一次连击的两次都算 1 → 显示 ×2', countOf(0) === '×2', countOf(0)],
  ['单独赠送各占一行（第 2 行 ×1）', countOf(1) === '×1', countOf(1)],
  ['单独赠送各占一行（第 3 行 ×1）', countOf(2) === '×1', countOf(2)],
  ['递增式连击显示最终数量 ×3', countOf(3) === '×3', countOf(3)],
];

let pass = 0;
for (const [n, ok, extra] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
