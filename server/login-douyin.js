/**
 * 抖音扫码登录：绕开它的接口风控。
 *
 * 抖音的 /passport/web/get_qrcode 对非浏览器请求一律返回 4031（缺 __ac_signature），
 * 服务端没法自己生成二维码。所以改成：用本机的 Chrome/Edge 开一个干净的临时窗口，
 * 让用户在真实页面里扫码，我们通过 DevTools 协议把登录后的 Cookie 读回来。
 *
 * 不需要额外依赖（CDP 就是 HTTP + WebSocket），也不需要打包 Chromium。
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const LOGIN_URL = 'https://www.douyin.com/';
const SESSION_TTL = 10 * 60 * 1000;

const WIN_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

/** 找本机能用的浏览器；没有就返回 null，让前端提示手动填 Cookie */
export function findBrowser() {
  const local = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
    .filter(Boolean)
    .flatMap((base) => [
      path.join(base, 'Google/Chrome/Application/chrome.exe'),
      path.join(base, 'Microsoft/Edge/Application/msedge.exe'),
    ]);
  const candidates =
    process.platform === 'win32'
      ? [...WIN_PATHS, ...local]
      : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // 下一个
    }
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 会话 id → { port, profile, pid, ws, at } */
const sessions = new Map();
let seq = 0;

async function waitForCdp(port, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error('浏览器调试端口没有响应，可能被安全软件拦截了');
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 10000);
    });
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // 已经退了
  }
}

async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  try {
    s.ws?.close();
  } catch {}
  if (s.pid) killTree(s.pid);
  await sleep(300);
  try {
    fs.rmSync(s.profile, { recursive: true, force: true });
  } catch {
    // 文件可能还被占用，留着无害
  }
}

export function listSessions() {
  return [...sessions.keys()];
}

export async function stopDouyinLogin(id) {
  if (id) return closeSession(id);
  for (const key of [...sessions.keys()]) await closeSession(key);
}

/** 打开一个临时浏览器窗口等着扫码 */
export async function startDouyinLogin() {
  const bin = findBrowser();
  if (!bin) {
    return {
      ok: false,
      error: '没找到 Chrome 或 Edge，请改用下面的「手动填 Cookie」',
    };
  }

  // 顺手清掉过期的
  for (const [id, s] of sessions) if (Date.now() - s.at > SESSION_TTL) closeSession(id);

  const port = await getFreePort();
  const profile = path.join(os.tmpdir(), `danmushow-login-${Date.now()}`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-features=Translate',
    '--window-size=460,760',
    LOGIN_URL,
  ];

  let pid = null;
  try {
    const child = spawn(bin, args, { stdio: 'ignore', detached: true });
    child.unref();
    pid = child.pid;
  } catch (e) {
    return { ok: false, error: `浏览器启动失败：${e.message}` };
  }

  let version;
  try {
    version = await waitForCdp(port);
  } catch (e) {
    if (pid) killTree(pid);
    return { ok: false, error: e.message };
  }

  let ws;
  try {
    ws = await openWs(version.webSocketDebuggerUrl);
  } catch (e) {
    if (pid) killTree(pid);
    return { ok: false, error: `连不上浏览器调试接口：${e.message}` };
  }

  const id = `dy${++seq}`;
  sessions.set(id, { port, profile, pid, ws, at: Date.now() });
  return {
    ok: true,
    id,
    message: '已打开浏览器窗口，请在里面点「登录」→ 扫码，扫码成功后这里会自动完成',
  };
}

/**
 * 轮询：等 .douyin.com 域下出现 sessionid 就认为登录成功
 * status: waiting / confirmed / error
 */
export async function pollDouyinLogin(id) {
  const s = sessions.get(id);
  if (!s) return { status: 'error', message: '会话已结束，请重新点击「浏览器扫码登录」' };

  const send = s._send || (s._send = cdp(s.ws));
  let result;
  try {
    result = await send('Storage.getCookies');
  } catch (e) {
    return { status: 'error', message: `读取浏览器 Cookie 失败：${e.message}` };
  }

  const all = (result.cookies || []).filter((c) => String(c.domain || '').includes('douyin.com'));
  const has = (name) => all.some((c) => c.name === name && c.value && c.value !== 'undefined' && c.value !== '');
  if (!has('sessionid') && !has('sessionid_ss')) {
    return { status: 'waiting', message: '等待扫码…' };
  }

  // 把浏览器里 .douyin.com 的 cookie 全部拼起来，跟真实请求一致
  const cookie = all
    .filter((c) => c.value && c.value !== 'undefined')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  await closeSession(id);
  return { status: 'confirmed', cookie, message: '登录成功，已读取 Cookie' };
}
