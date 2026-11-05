/**
 * B站扫码登录：走官方 passport 的二维码接口。
 * 只做一件事——把登录后的 Cookie 取出来交给控制台，不做持久化、不上传。
 */
import QRCode from 'qrcode-generator';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const HEADERS = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
};

/** 扫码会话，key → 创建时间。10 分钟没人理就清掉 */
const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000;

function gc() {
  const now = Date.now();
  for (const [k, at] of sessions) if (now - at > SESSION_TTL) sessions.delete(k);
}

/** 二维码内容是个链接，用纯 JS 库画成 SVG 给前端直接贴 */
function toSvg(text) {
  const qr = QRCode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 1 });
}

export async function startBilibiliLogin() {
  gc();
  const r = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', { headers: HEADERS });
  const j = await r.json();
  if (j.code !== 0 || !j.data?.qrcode_key) {
    throw new Error(j.message || '生成二维码失败');
  }
  const { url, qrcode_key } = j.data;
  sessions.set(qrcode_key, Date.now());
  return { key: qrcode_key, url, svg: toSvg(url) };
}

/** 从轮询响应的 Set-Cookie 里挑出建连接真正需要的几个 */
function pickCookies(setCookies) {
  const want = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
  const map = new Map();
  for (const line of setCookies) {
    const first = String(line).split(';')[0];
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (name && value) map.set(name, value);
  }
  const out = [];
  for (const name of want) if (map.has(name)) out.push(`${name}=${map.get(name)}`);
  // 兜底：Set-Cookie 没带全时，从 data.url 的查询串里再捞一遍
  return out;
}

function cookiesFromUrl(u) {
  try {
    const q = new URL(u).searchParams;
    const want = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
    const out = [];
    for (const name of want) {
      const v = q.get(name);
      if (v) out.push(`${name}=${v}`);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 返回 { status, cookie?, message? }
 * status: waiting 未扫码 / scanned 已扫待确认 / confirmed 成功 / expired 过期
 */
export async function pollBilibiliLogin(key) {
  if (!key || !sessions.has(key)) return { status: 'expired', message: '二维码已失效，请刷新' };

  const r = await fetch(
    `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
    { headers: HEADERS },
  );
  const j = await r.json();
  const code = j.data?.code;
  const setCookies = r.headers.getSetCookie?.() || [];

  if (code === 0) {
    sessions.delete(key);
    let list = pickCookies(setCookies);
    if (!list.some((c) => c.startsWith('SESSDATA='))) {
      const fromUrl = cookiesFromUrl(j.data?.url || '');
      if (fromUrl.length) list = fromUrl;
    }
    if (!list.some((c) => c.startsWith('SESSDATA='))) {
      return { status: 'expired', message: '登录成功但没拿到 Cookie，可能是接口变更' };
    }
    return { status: 'confirmed', cookie: list.join('; ') };
  }
  if (code === 86101) return { status: 'waiting' };
  if (code === 86090) return { status: 'scanned' };
  if (code === 86038) {
    sessions.delete(key);
    return { status: 'expired', message: '二维码已过期，请刷新' };
  }
  return { status: 'waiting', message: j.message || '' };
}
