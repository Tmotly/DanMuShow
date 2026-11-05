// 用 jsdom 把 public/app.js 真跑一遍：验证礼物渲染、表情、在线观众、昵称回填
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
    config: {
      rooms: { bilibili: { roomId: '1' }, douyin: { roomId: '2' } },
      display: { maxDanmaku: 80, maxGifts: 6, showHeader: true, giftRatio: 45, showGifts: true },
    },
    state: {
      platforms: {
        bilibili: { id: 'bilibili', status: 'connected', online: 15600, title: '测试直播间', anchor: '主播' },
        douyin: { id: 'douyin', status: 'connected', online: 8200, title: '测试直播间', anchor: '主播' },
      },
    },
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
  emit(obj) {
    this.onmessage && this.onmessage({ data: JSON.stringify(obj) });
  }
};

window.eval(appJs);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = window.document;
const txt = (id) => doc.getElementById(id)?.textContent?.trim();

await wait(50);

sock.emit({
  type: 'hello',
  state: {
    platforms: {
      bilibili: { id: 'bilibili', status: 'connected', online: 15600, title: '测试直播间', anchor: '主播' },
      douyin: { id: 'douyin', status: 'connected', online: 8200, title: '测试直播间', anchor: '主播' },
    },
  },
  // 故意用带方括号的 key，验证前端对两种写法都兼容
  emoji: { bilibili: { '[花]': 'https://i0.hdslb.com/bfs/emote/flower.png' }, douyin: {} },
  recent: [],
});
await wait(20);

// 1. 在线观众
console.log('=== 在线观众 ===');
console.log('总数:', txt('onlineTotal'), '| 明细:', doc.getElementById('onlineSplit').textContent.replace(/\s+/g, ' ').trim());
console.log('条可见:', !doc.getElementById('onlineBar').hidden);

// 2. 礼物（B站 V2 结构 + 抖音）
sock.emit({ type: 'message', message: { id: 'g1', platform: 'bilibili', kind: 'gift', giftKey: 'u1:粉丝团灯牌', user: { id: 'u1', name: '小明', avatar: '' }, gift: { name: '粉丝团灯牌', count: 2, unitPrice: 100, coinType: 'gold', image: 'https://s1.hdslb.com/bfs/live/a.png' } } });
await wait(10);
sock.emit({ type: 'message', message: { id: 'g2', platform: 'douyin', kind: 'gift', giftKey: 'u2:玫瑰', user: { id: 'u2', name: '小红', avatar: '' }, gift: { name: '玫瑰', count: 5, unitPrice: 10, coinType: 'diamond' } } });
await wait(20);

const gifts = doc.getElementById('giftStream');
console.log('\n=== 礼物区 ===');
console.log('条数:', gifts.children.length);
for (const g of gifts.children) {
  console.log(' •', g.textContent.replace(/\s+/g, ' ').trim(), '| 有礼物图:', !!g.querySelector('.gift-img'));
}

// 3. 弹幕：大表情 / [花] 映射 / 纯文本
sock.emit({ type: 'message', message: { id: 'c1', platform: 'bilibili', kind: 'chat', user: { id: 'u3', name: '张三', avatar: '' }, text: '普通弹幕' } });
sock.emit({ type: 'message', message: { id: 'c2', platform: 'bilibili', kind: 'chat', user: { id: 'u4', name: '李四', avatar: '' }, text: '就这', emoji: { url: 'https://i0.hdslb.com/bfs/live/big.png' } } });
sock.emit({ type: 'message', message: { id: 'c3', platform: 'bilibili', kind: 'chat', user: { id: 'u5', name: '王五', avatar: '' }, text: '送你[花]哈哈' } });
sock.emit({ type: 'message', message: { id: 'c4', platform: 'douyin', kind: 'chat', user: { id: 'u6', name: '赵六', avatar: '' }, text: '这个[没有映射]的表情' } });
await wait(20);

const chat = doc.getElementById('chatStream');
console.log('\n=== 弹幕区 ===');
for (const c of chat.children) {
  console.log(' •', c.textContent.replace(/\s+/g, ' ').trim(), '| 表情图:', c.querySelectorAll('.dm-emoji').length, '| 胶囊:', c.querySelectorAll('.emoji-chip').length);
}

// 4. 昵称打码回填
sock.emit({ type: 'message', message: { id: 'c5', platform: 'bilibili', kind: 'chat', user: { id: '999', name: '一***', avatar: '' }, text: '打码用户' } });
await wait(10);
sock.emit({ type: 'message', message: { id: 'u999', platform: 'bilibili', kind: 'user', silent: true, user: { id: '999', name: '真实昵称', avatar: 'https://i1.hdslb.com/bfs/face/x.jpg' } } });
await wait(20);
const masked = [...chat.children].find((c) => c.dataset.uid === '999');
console.log('\n=== 昵称回填 ===');
console.log('回填后:', masked?.querySelector('.name')?.textContent, '| 有头像图:', !!masked?.querySelector('.avatar img'));

// 5. 表情断言
const row = (uid) => [...chat.children].find((c) => c.dataset.uid === uid);
const checks = [
  ['大表情渲染成图', row('u4')?.querySelectorAll('.dm-emoji').length === 1],
  ['[花] 命中映射渲染成图（带括号 key 也认）', row('u5')?.querySelectorAll('.dm-emoji').length === 1],
  ['[花] 没有被降级成文字', !row('u5')?.textContent.includes('[花]')],
  ['没有映射的表情退成胶囊', row('u6')?.querySelectorAll('.emoji-chip').length === 1],
  ['昵称回填生效', masked?.querySelector('.name')?.textContent === '真实昵称'],
];

console.log('\n=== 表情断言 ===');
checks.push(['礼物区按配置占 45% 高度', doc.getElementById('giftZone').style.flex === '0 0 45%', doc.getElementById('giftZone').style.flex]);
checks.push(['礼物区默认可见', doc.getElementById('giftZone').hidden === false]);

// 运行中把礼物区关掉，面板应立即隐藏
sock.emit({
  type: 'config',
  config: { rooms: { bilibili: { roomId: '1' } }, display: { maxDanmaku: 80, maxGifts: 6, showHeader: true, giftRatio: 45, showGifts: false } },
});
await wait(20);
checks.push(['关掉礼物区后面板隐藏', doc.getElementById('giftZone').hidden === true]);

let pass = 0;
for (const [n, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${n}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
