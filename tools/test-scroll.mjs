// 验证两个区可滚动翻阅：DOM 结构、上限淘汰、空状态、按钮存在
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('D:/DanmuFree/sign/');
const { JSDOM } = require('jsdom');

const ROOT = 'C:/Users/jiaoj/Documents/deepseek-harness/default-workspace/danmu-hub';
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');

const MAX_DM = 20; // 测试里调小，方便验证淘汰
const MAX_GIFT = 5;

const dom = new JSDOM(html, { url: 'http://127.0.0.1:7801/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.CSS = { escape: (s) => String(s) };
window.fetch = async () => ({
  ok: true,
  json: async () => ({
    config: {
      rooms: { bilibili: { roomId: '1' } },
      display: { maxDanmaku: MAX_DM, maxGifts: MAX_GIFT, showHeader: true },
    },
    state: { platforms: { bilibili: { id: 'bilibili', status: 'connected', online: 1 } } },
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
await wait(40);

const doc = window.document;
const chat = doc.getElementById('chatStream');
const gift = doc.getElementById('giftStream');
const chatBtn = doc.getElementById('chatToBottom');
const giftBtn = doc.getElementById('giftToBottom');

const checks = [];
const check = (n, ok, extra = '') => checks.push({ n, ok, extra });

// 1. 结构
check('两个区都有「回到底部」按钮', !!chatBtn && !!giftBtn);
check('初始按钮是隐藏的', chatBtn.hidden && giftBtn.hidden);

// 2. 空状态带 is-empty（不做底部占位）
sock.emit({ type: 'hello', state: { platforms: {} }, emoji: {}, recent: [] });
await wait(20);
check('空状态时流上加了 is-empty', chat.classList.contains('is-empty') && gift.classList.contains('is-empty'));

// 3. 灌超过上限的弹幕
for (let i = 0; i < MAX_DM + 15; i++) {
  sock.emit({
    type: 'message',
    message: { id: 'c' + i, platform: 'bilibili', kind: 'chat', user: { id: 'u' + i, name: '用户' + i, avatar: '' }, text: '消息' + i },
  });
}
await wait(30);
check(`弹幕被裁到上限 ${MAX_DM}`, chat.children.length === MAX_DM, `实际 ${chat.children.length}`);
check('淘汰的是最老的（保留最新）', chat.lastElementChild?.textContent.includes('消息' + (MAX_DM + 14)));
check('有内容后 is-empty 被移除', !chat.classList.contains('is-empty'));

// 4. 礼物同理
for (let i = 0; i < MAX_GIFT + 4; i++) {
  sock.emit({
    type: 'message',
    message: {
      id: 'g' + i,
      platform: 'douyin',
      kind: 'gift',
      giftKey: 'gk' + i,
      user: { id: 'gu' + i, name: '土豪' + i, avatar: '' },
      gift: { name: '礼物' + i, count: 1, unitPrice: 10, coinType: 'diamond' },
    },
  });
}
await wait(30);
check(`礼物被裁到上限 ${MAX_GIFT}`, gift.children.length === MAX_GIFT, `实际 ${gift.children.length}`);

// 5. CSS 检查
const streamRule = css.match(/\.stream\s*\{[^}]*\}/)?.[0] || '';
check('.stream 可纵向滚动', streamRule.includes('overflow-y: auto'));
check('.stream 没有用 justify-content: flex-end（会滚不到顶部）', !streamRule.includes('justify-content'));
check('.stream 有底部占位 ::before', /\.stream::before\s*\{[^}]*flex:\s*1 0 0/.test(css));
check('滚动条样式存在', css.includes('::-webkit-scrollbar-thumb'));
check('obs 模式隐藏滚动条', /body\.obs \.stream\s*\{[^}]*scrollbar-width:\s*none/.test(css));
check('obs 模式隐藏回底按钮', /body\.obs \.to-bottom[\s\S]{0,60}display:\s*none/.test(css));

let pass = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.n}${c.extra ? ' — ' + c.extra : ''}`);
  if (c.ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
