import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { loadConfig, saveConfig, ensureConfigFile, effectiveConfigPath } from './config.js';
import { normalizeRel, assetExists, readAsset, PACKAGED } from './assets.js';
import { onClient, state, stats, broadcast, setPlatform } from './hub.js';
import { BilibiliSource, checkLogin } from './platforms/bilibili.js';
import { DouyinSource } from './platforms/douyin.js';
import { startDemo, stopDemo } from './demo.js';

ensureConfigFile();

/**
 * Windows 控制台的「快速编辑模式」会要命：窗口里只要有文本被选中，
 * 任何往 stdout 写的操作都会阻塞，而 Node 在 Windows 上写 TTY 是同步的，
 * 于是整个事件循环停住——表现就是「一直显示连接中，按一下回车才好」。
 * 这里在启动时把它关掉（只是关掉选中暂停，不影响复制；失败也不影响运行）。
 */
function disableQuickEdit() {
  if (process.platform !== 'win32') return;
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type -Namespace W -Name C -MemberDefinition \'[DllImport("kernel32.dll")]public static extern IntPtr GetStdHandle(int n);[DllImport("kernel32.dll")]public static extern bool GetConsoleMode(IntPtr h,out uint m);[DllImport("kernel32.dll")]public static extern bool SetConsoleMode(IntPtr h,uint m);\'',
    '$h=[W.C]::GetStdHandle(-10)',
    '$m=0',
    'if([W.C]::GetConsoleMode($h,[ref]$m)){[void][W.C]::SetConsoleMode($h,($m -band (-bnot 0x40)))}',
  ].join('; ');
  try {
    // 必须和本进程共用同一个控制台才能改它的输入模式，所以不设 windowsHide
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' }).unref();
  } catch {
    // 没 PowerShell 就算了，不影响主流程
  }
}
disableQuickEdit();

/* 日志同时落文件：万一控制台还是卡住，也能从文件里看出走到哪一步了 */
const LOG_FILE = path.join(path.dirname(effectiveConfigPath()), 'danmushow.log');

function log(...a) {
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${a.join(' ')}`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // 写不了就算了
  }
  console.log(line);
}

const cfg = loadConfig();
const PORT = Number(process.env.PORT || cfg.port || 7801);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const sources = { bilibili: null, douyin: null };
let demoOn = false;

/* ---------------- 平台启动 / 停止 ---------------- */

function startPlatform(id) {
  const conf = cfg.rooms[id];
  const existing = sources[id];
  if (existing) {
    existing.stop();
    sources[id] = null;
  }
  if (!conf || !String(conf.roomId || '').trim()) {
    setPlatform(id, { status: 'idle', roomId: '', title: '', anchor: '', online: 0, error: '' });
    return;
  }
  const Cls = id === 'bilibili' ? BilibiliSource : DouyinSource;
  sources[id] = new Cls({ roomId: conf.roomId, cookie: conf.cookie }, { log });
  sources[id].start().catch((e) => {
    log(`[${id}] 启动失败`, e.message);
    setPlatform(id, { status: 'error', error: e.message });
  });
}

function stopPlatform(id) {
  sources[id]?.stop();
  sources[id] = null;
}

/* ---------------- 头像代理（绕热链 + 本地缓存） ---------------- */

const AVATAR_ALLOW = ['hdslb.com', 'bilibili.com', 'douyinpic.com', 'douyincdn.com', 'byteimg.com', 'bytedance.com', 'douyin.com'];
const avatarCache = new Map();
const AVATAR_CACHE_MAX = 400;

async function handleAvatar(req, res, url) {
  const target = url.searchParams.get('u');
  if (!target) return json(res, 400, { error: 'missing u' });
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return json(res, 400, { error: 'bad url' });
  }
  if (!AVATAR_ALLOW.some((h) => parsed.hostname.endsWith(h))) {
    return json(res, 403, { error: 'host not allowed' });
  }

  const hit = avatarCache.get(target);
  if (hit) {
    res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'public, max-age=86400' });
    return res.end(hit.buf);
  }

  try {
    const r = await fetch(target, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        referer: parsed.hostname.includes('hdslb') ? 'https://live.bilibili.com/' : 'https://live.douyin.com/',
      },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'image/jpeg';
    if (avatarCache.size > AVATAR_CACHE_MAX) avatarCache.clear();
    avatarCache.set(target, { buf, type });
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('avatar not found');
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/* ---------------- HTTP ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/state') {
    return json(res, 200, { config: cfg, state, stats: stats() });
  }

  if (p === '/api/avatar') return handleAvatar(req, res, url);

  // B站登录态检查：控制台用来提示「填了 Cookie 才看得到全名/头像」
  if (p === '/api/bili/login') {
    const cookie = url.searchParams.get('cookie') || cfg.rooms.bilibili?.cookie || '';
    const r = await checkLogin(cookie);
    return json(res, 200, r);
  }

  if (p === '/api/config' && req.method === 'POST') {
    const patch = await readBody(req);
    const before = JSON.stringify(cfg.rooms);
    const next = saveConfig(patch);
    // 就地更新配置对象（引用被其他地方持有）
    Object.assign(cfg, next);
    const after = JSON.stringify(cfg.rooms);
    if (before !== after) {
      for (const id of ['bilibili', 'douyin']) startPlatform(id);
    }
    broadcast({ type: 'config', config: cfg });
    return json(res, 200, { ok: true, config: cfg });
  }

  if (p === '/api/restart' && req.method === 'POST') {
    const body = await readBody(req);
    const id = body.platform;
    if (id === 'bilibili' || id === 'douyin') startPlatform(id);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/demo' && req.method === 'POST') {
    const body = await readBody(req);
    demoOn = !!body.on;
    if (demoOn) startDemo();
    else stopDemo();
    return json(res, 200, { ok: true, on: demoOn });
  }

  // 静态文件（源码运行时读 public/，打包后从内联资源里取）
  const rel = normalizeRel(p === '/' ? 'index.html' : p);
  if (!rel) return json(res, 403, { error: 'forbidden' });

  let body = assetExists(rel) ? readAsset(rel) : null;
  if (!body && !path.extname(rel)) {
    // 无扩展名的路径回落到 index.html（方便 /control 这类路由）
    body = readAsset('index.html');
  }
  if (!body) return json(res, 404, { error: 'not found' });

  res.writeHead(200, {
    'content-type': MIME[path.extname(rel)] || MIME['.html'],
    'cache-control': 'no-cache',
  });
  res.end(body);
});

/* ---------------- WebSocket ---------------- */

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const off = onClient(ws);
  ws.on('close', off);
  ws.on('error', off);
});

/* ---------------- 启动 ---------------- */

/**
 * 打开系统默认浏览器。
 * 双击 启动.bat 时带 --open，服务起来之后再开，避免“网页打不开”的时序问题。
 */
function openBrowser(url) {
  if (process.env.DANMU_NO_BROWSER) return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // 开不了就算了，窗口里已经打印地址
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`  端口 ${PORT} 已被占用，可能已经开着一个 DanMuShow 了。`);
    log(`  直接访问 http://127.0.0.1:${PORT}/control.html 就行。`);
    openBrowser(`http://127.0.0.1:${PORT}/control.html`);
    setTimeout(() => process.exit(0), 2500);
    return;
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  log('');
  log('  弹幕聚合面板已启动');
  log(`  展示面板  http://127.0.0.1:${PORT}/`);
  log(`  控制台    http://127.0.0.1:${PORT}/control.html`);
  log(`  OBS 源    http://127.0.0.1:${PORT}/?obs=1`);
  log(`  配置文件  ${effectiveConfigPath()}`);
  log('');
  for (const id of ['bilibili', 'douyin']) startPlatform(id);

  if (process.argv.includes('--demo')) {
    demoOn = true;
    startDemo();
    log('  演示模式：正在生成模拟消息');
  }

  // 双击 exe 时默认帮用户打开控制台；源码运行要显式 --open
  if (PACKAGED || process.argv.includes('--open')) {
    openBrowser(`http://127.0.0.1:${PORT}/control.html`);
  }
});

function shutdown() {
  log('正在退出…');
  stopDemo();
  for (const id of ['bilibili', 'douyin']) stopPlatform(id);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
