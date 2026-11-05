// 控制台页面：布局滑块/预设/礼物区开关 + 扫码登录流程
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, requireJSDOM } from './_lib.mjs';

const { JSDOM } = requireJSDOM();

const html = fs.readFileSync(path.join(ROOT, 'public/control.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/control.js'), 'utf8');

const dom = new JSDOM(html, { url: 'http://127.0.0.1:7801/control.html', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;

const CONFIG = {
  rooms: { bilibili: { roomId: '1', cookie: '' }, douyin: { roomId: '2', cookie: '' } },
  display: { title: '', maxDanmaku: 200, maxGifts: 30, giftRatio: 32, showGifts: true, showHeader: true },
};

let pollCount = 0;
window.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (obj) => ({ ok: true, json: async () => obj });
  if (u.startsWith('/api/state')) return ok({ config: CONFIG, state: { platforms: {} } });
  if (u.startsWith('/api/login/bilibili/start')) {
    return ok({ ok: true, key: 'K1', svg: '<svg id="qr-svg" width="10" height="10"></svg>' });
  }
  if (u.startsWith('/api/login/bilibili/poll')) {
    pollCount++;
    return ok({ ok: true, status: 'confirmed', cookie: 'SESSDATA=abc; bili_jct=def' });
  }
  if (u.startsWith('/api/login/douyin/start')) {
    return ok({ ok: false, error: '没找到 Chrome 或 Edge' });
  }
  if (u.startsWith('/api/login/douyin/stop')) return ok({ ok: true });
  if (u.startsWith('/api/config')) return ok({ ok: true, config: CONFIG });
  return ok({});
};

window.eval(js);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(80);

const checks = [];
const giftZone = doc.getElementById('lpGift');
const ratioInput = doc.getElementById('giftRatio');
const ratioVal = doc.getElementById('ratioVal');
const preview = doc.getElementById('layoutPreview');

checks.push(['回填比例 32%', ratioInput.value === '32' && ratioVal.textContent === '32%', `${ratioInput.value}/${ratioVal.textContent}`]);
checks.push(['预览高度跟随 32%', giftZone.style.flex === '0 0 32%', giftZone.style.flex]);

// 拖动滑块
ratioInput.value = '55';
ratioInput.dispatchEvent(new window.Event('input', { bubbles: true }));
checks.push(['滑块改成 55 后预览同步', giftZone.style.flex === '0 0 55%' && ratioVal.textContent === '55%', giftZone.style.flex]);

// 预设按钮
const preset50 = [...doc.querySelectorAll('.preset-row .btn')].find((b) => b.dataset.ratio === '50');
preset50.dispatchEvent(new window.Event('click', { bubbles: true }));
checks.push(['点预设「礼物多」→ 50%', giftZone.style.flex === '0 0 50%' && ratioInput.value === '50', `${giftZone.style.flex}/${ratioInput.value}`]);
checks.push(['预设按钮高亮', preset50.classList.contains('active')]);

// 超界夹紧
ratioInput.value = '99';
ratioInput.dispatchEvent(new window.Event('input', { bubbles: true }));
checks.push(['超上限夹到 75%', giftZone.style.flex === '0 0 75%', giftZone.style.flex]);

// 关掉礼物区
const showGifts = doc.getElementById('showGifts');
showGifts.checked = false;
showGifts.dispatchEvent(new window.Event('change', { bubbles: true }));
checks.push(['关掉礼物区后预览隐藏礼物块', preview.classList.contains('no-gift')]);

// 扫码登录（B站）
const modal = doc.getElementById('loginModal');
doc.getElementById('scanBili').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(120);
checks.push(['点扫码弹出对话框', modal.hidden === false]);
checks.push(['二维码 SVG 已插入', !!doc.querySelector('#loginQr svg')]);
await wait(2200); // 等一次轮询
checks.push(['登录成功后 Cookie 填入', doc.getElementById('biliCookie').value.includes('SESSDATA=abc'), doc.getElementById('biliCookie').value]);

// 抖音没有浏览器时应给出错误而不是一直转圈
doc.getElementById('scanDouyin').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(150);
const st = doc.getElementById('loginStatus');
checks.push(['抖音没有浏览器时提示错误', st.className.includes('err') && st.textContent.includes('Chrome'), st.textContent]);

let pass = 0;
for (const [n, ok, extra] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${n}${extra && !ok ? ' — ' + extra : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
