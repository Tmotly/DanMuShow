// 检查 obs 模式的样式结果：气泡底、平台标记底、无文字阴影、无隐藏鼠标
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './_lib.mjs';
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

// 截出 OBS 段（从 OBS 注释到“窄屏适配”）
const start = css.indexOf('OBS 模式');
const end = css.indexOf('窄屏适配');
const obs = css.slice(start, end);

const checks = [];
const check = (name, ok, extra = '') => checks.push({ name, ok, extra });

check('obs 段里没有 text-shadow', !obs.includes('text-shadow'));
check('obs 段里没有 cursor: none', !obs.includes('cursor'));
check('app.js 里没有 cursor = none', !app.includes("cursor = 'none'"));
check('弹幕内容有圆角气泡', /body\.obs \.msg-text\s*\{[^}]*border-radius/.test(obs) && /body\.obs \.msg-text\s*\{[^}]*background:\s*rgba/.test(obs));
check('气泡只包文字（fit-content + flex-start）', /body\.obs \.msg-text\s*\{[^}]*width:\s*fit-content/.test(obs) && /body\.obs \.msg-text\s*\{[^}]*align-self:\s*flex-start/.test(obs));
check('礼物条有圆角底', /body\.obs \.msg\.gift\s*\{[^}]*background:\s*rgba/.test(obs));
check('平台标记不透明实色', /body\.obs \.plat\.bilibili\s*\{[^}]*background:\s*#0a7ea4/.test(obs) && /body\.obs \.plat\.douyin\s*\{[^}]*background:\s*#d81e45/.test(obs));
check('礼物金额用浅色胶囊', /\.gift-price\s*\{[^}]*background:\s*rgba\(255, 255, 255, 0\.16\)/.test(css));
check('面板/分区仍然透明', /body\.obs \.panel,[\s\S]*?background:\s*transparent !important/.test(obs));
check('bg=1 时气泡退化为透明', /body\.obs\.keep-bg \.msg-text\s*\{[^}]*background:\s*transparent !important/.test(obs));

let pass = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.extra ? ' — ' + c.extra : ''}`);
  if (c.ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
process.exit(pass === checks.length ? 0 : 1);
