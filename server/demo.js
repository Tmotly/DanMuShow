/** 演示模式：不连真实房间也能看到面板长什么样 */
import { push, setPlatform } from './hub.js';

const NAMES = [
  '夜航船', '橘子汽水', '不打烊的猫', '阿澈', '会飞的鱼丸', '小满', '壹原侑子', '雾里看花',
  '半糖去冰', '海盐芝士', '陆沉的耳机', '蓝色骨头', '一只独角兽', '林深见鹿', '早八人',
  '西瓜太郎', '云朵收藏家', '不睡觉的猫头鹰', '红莲', '南风知我意',
];

const CHATS = [
  '主播这个操作太秀了', '哈哈哈哈哈哈笑死', '来了来了', '刚进来，主播在打什么段位',
  '这个皮肤哪里买的', '前排放个板凳', '卡了卡了，画面在转圈', '主播声音好听',
  '求个歌名', '这波我愿称之为神', '能不能点个关注', '前面的说得对',
  '晚自习刚下，来晚了', '主播明天还播吗', '这局稳了', '设备是啥配置啊',
  '我愿称之为最强', '六块钱的快乐', '已经三连了', '弹幕护体',
];

const GIFTS = [
  { name: '小心心', price: 0 },
  { name: '棒棒糖', price: 1 },
  { name: '小花花', price: 5 },
  { name: '为你打call', price: 10 },
  { name: '能量饮料', price: 30 },
  { name: '浪漫烟花', price: 99 },
];

const PALETTE = ['#ff6b81', '#5ee7df', '#ffd166', '#a78bfa', '#4ade80', '#fb923c', '#38bdf8', '#f472b6'];

function svgAvatar(seed) {
  const c1 = PALETTE[seed % PALETTE.length];
  const c2 = PALETTE[(seed * 3 + 2) % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="80" height="80" fill="url(#g)"/><circle cx="40" cy="30" r="14" fill="rgba(255,255,255,.85)"/><ellipse cx="40" cy="66" rx="24" ry="18" fill="rgba(255,255,255,.85)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
let timer = null;
let giftTimer = null;

function user(platform, index) {
  const name = NAMES[index % NAMES.length];
  return {
    id: `${platform}-${index}`,
    name,
    avatar: svgAvatar(index + (platform === 'douyin' ? 3 : 0)),
  };
}

export function startDemo() {
  stopDemo();
  setPlatform('bilibili', {
    status: 'live',
    roomId: '演示房间',
    title: '演示：B站 + 抖音同屏',
    anchor: '主播本人',
    online: 8421,
  });
  setPlatform('douyin', {
    status: 'live',
    roomId: '演示房间',
    title: '演示：B站 + 抖音同屏',
    anchor: '主播本人',
    online: 12693,
  });

  let i = 0;
  timer = setInterval(() => {
    const platform = Math.random() > 0.45 ? 'douyin' : 'bilibili';
    const idx = i++;
    const u = user(platform, idx);
    const roll = Math.random();
    if (roll > 0.9) {
      const g = pick(GIFTS);
      const count = g.price === 0 ? Math.ceil(Math.random() * 20) : 1 + Math.floor(Math.random() * 3);
      push({
        platform,
        kind: 'gift',
        giftKey: `${u.id}:${g.name}`,
        user: u,
        gift: { name: g.name, count, unitPrice: g.price, coinType: platform === 'bilibili' ? 'gold' : 'diamond' },
      });
    } else if (roll > 0.86) {
      push({ platform, kind: 'enter', user: u, text: '进入了直播间' });
    } else {
      push({ platform, kind: 'chat', user: u, text: pick(CHATS) });
    }
  }, 900);

  // 礼物偶尔来个连击，验证前端合并
  giftTimer = setInterval(() => {
    const platform = Math.random() > 0.5 ? 'douyin' : 'bilibili';
    const u = user(platform, Math.floor(Math.random() * 8));
    const g = pick(GIFTS);
    push({
      platform,
      kind: 'gift',
      giftKey: `${u.id}:${g.name}`,
      user: u,
      gift: { name: g.name, count: 1, unitPrice: g.price, coinType: platform === 'bilibili' ? 'gold' : 'diamond' },
    });
  }, 12000);
}

export function stopDemo() {
  clearInterval(timer);
  clearInterval(giftTimer);
  timer = null;
  giftTimer = null;
}
