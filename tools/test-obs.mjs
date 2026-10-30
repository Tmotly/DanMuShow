// 验证 OBS 各种 URL 参数下 body 的类名和透明底设置
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, requireJSDOM } from './_lib.mjs';

const { JSDOM } = requireJSDOM();

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

async function run(query) {
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:7801/${query}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.CSS = { escape: (s) => String(s) };
  window.fetch = async () => ({
    ok: true,
    json: async () => ({ config: { rooms: {}, display: {} }, state: { platforms: {} } }),
  });
  window.WebSocket = class {
    constructor() {
      this.readyState = 0;
    }
    send() {}
    close() {}
  };
  window.eval(appJs);
  await new Promise((r) => setTimeout(r, 30));
  const body = window.document.body;
  const head = window.document.getElementById('head');
  return {
    query,
    classes: [...body.classList].join(' ') || '(无)',
    htmlBg: window.document.documentElement.style.background || '(未设置)',
    bodyBg: body.style.background || '(未设置)',
    headDisplay: head.style.display || '(默认显示)',
  };
}

for (const q of ['', '?obs=1', '?obs=1&head=1', '?obs=1&bg=1', '?obs=1&nohead=1']) {
  console.log(JSON.stringify(await run(q)));
}

// CSS 大括号配平
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const open = (css.match(/{/g) || []).length;
const close = (css.match(/}/g) || []).length;
console.log(`\nstyle.css 括号: { ${open} / } ${close} -> ${open === close ? '配平' : '不配平！'}`);
