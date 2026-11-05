import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGED } from './assets.js';

function hereDir() {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return path.dirname(process.execPath);
  }
}
export const ROOT = path.resolve(hereDir(), '..');

/** 打包版把配置放用户目录，避开 Program Files 写不进去的问题 */
export function dataDir() {
  if (process.env.DANMU_DATA) return path.resolve(process.env.DANMU_DATA);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'DanMuShow');
  }
  return path.join(os.homedir(), '.danmushow');
}

function resolveConfigPath() {
  // 自检 / 多实例 / 测试可以用环境变量指到别处，优先级最高
  if (process.env.DANMU_CONFIG) return path.resolve(process.env.DANMU_CONFIG);
  if (process.env.DANMU_DATA) return path.join(path.resolve(process.env.DANMU_DATA), 'config.json');
  if (!PACKAGED) return path.join(ROOT, 'config.json');
  // 绿色版：exe 旁边放了 config.json 就优先用它
  const beside = path.join(path.dirname(process.execPath), 'config.json');
  if (fs.existsSync(beside)) return beside;
  return path.join(dataDir(), 'config.json');
}

export const CONFIG_PATH = resolveConfigPath();

export const DEFAULT_CONFIG = {
  port: 7801,
  rooms: {
    bilibili: { roomId: '', cookie: '' },
    douyin: { roomId: '', cookie: '' },
  },
  display: {
    title: '',
    maxDanmaku: 200,
    maxGifts: 30,
    showEnter: false,
    showLike: false,
    mergeGiftCombo: true,
    fontScale: 1,
    showHeader: true,
  },
};

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    raw = {};
  }
  cache = deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  return cache;
}

/** 实际生效的配置文件路径（可能在降级后变化） */
let effectivePath = CONFIG_PATH;
export function effectiveConfigPath() {
  return effectivePath;
}

function writeConfigFile(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json, 'utf8');
}

/** 依次尝试：正常配置位置 → exe 同目录 → 当前工作目录 */
function candidates() {
  const list = [CONFIG_PATH];
  if (PACKAGED) {
    list.push(path.join(path.dirname(process.execPath), 'config.json'));
    list.push(path.join(process.cwd(), 'config.json'));
  }
  return [...new Set(list)];
}

export function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch || {});
  cache = next;
  const json = JSON.stringify(next, null, 2);
  for (const file of candidates()) {
    try {
      writeConfigFile(file, json);
      effectivePath = file;
      return next;
    } catch {
      // 换个位置再试
    }
  }
  // 实在写不了也别崩：本次运行内存里生效，只是重启会丢
  console.warn('[配置] 没有可写的位置，本次修改只在内存里生效：', candidates().join(' / '));
  return next;
}

export function ensureConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) return;
  const json = JSON.stringify(DEFAULT_CONFIG, null, 2);
  for (const file of candidates()) {
    try {
      writeConfigFile(file, json);
      effectivePath = file;
      return;
    } catch {
      // 换下一个
    }
  }
  console.warn('[配置] 找不到可写目录，先按默认配置运行（可用 DANMU_DATA 指定目录）');
}
