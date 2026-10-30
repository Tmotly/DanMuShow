import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 自检 / 多实例可以用环境变量指到别的配置文件，避免污染真实配置
export const CONFIG_PATH = process.env.DANMU_CONFIG
  ? path.resolve(process.env.DANMU_CONFIG)
  : path.join(ROOT, 'config.json');

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

export function saveConfig(patch) {
  const next = deepMerge(loadConfig(), patch || {});
  cache = next;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function ensureConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  }
}
