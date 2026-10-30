// 用真实 cookie 拉一次 B站表情包，看映射表里到底有什么
import fs from 'node:fs';

const ROOT = 'C:/Users/jiaoj/Documents/deepseek-harness/default-workspace/danmu-hub';
const cfg = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const cookie = cfg.rooms.bilibili.cookie || '';
const room = cfg.rooms.bilibili.roomId;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const u = `https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons?platform=pc&room_id=${room}`;
const j = await (await fetch(u, { headers: { 'user-agent': UA, cookie, referer: `https://live.bilibili.com/${room}` } })).json();

console.log('code:', j.code, '| 包数:', j.data?.data?.length || 0);
const all = [];
for (const pkg of j.data?.data || []) {
  const list = pkg.emoticons || [];
  console.log(`  包 ${pkg.pkg_name || pkg.pkg_id} (id=${pkg.pkg_id}) → ${list.length} 个`);
  for (const e of list) {
    all.push({ name: e.emoji, unique: e.emoticon_unique, url: e.url, type: e.type, perm: e.perm });
  }
}
console.log('\n总表情数:', all.length);
console.log('前 8 个:', JSON.stringify(all.slice(0, 8), null, 1));

for (const probe of ['花', '赞', '捂脸', 'doge', '[花]']) {
  const hit = all.find((e) => e.name === probe || e.name === probe.replace(/[[\]]/g, ''));
  console.log(`查 "${probe}" → ${hit ? `命中 name=${hit.name} url=${(hit.url || '').slice(0, 60)}` : '没有'}`);
}

const withUrl = all.filter((e) => e.url && e.url.startsWith('http'));
console.log('\n带 URL 的数量:', withUrl.length);
console.log('名字样例:', all.slice(0, 30).map((e) => e.name).join(' / '));
