/**
 * 前端静态资源的统一访问层。
 *
 * - 源码运行：从 public/ 读盘
 * - 打包成 exe：所有前端文件在构建时以 base64 内联进 globalThis.__DANMU_ASSETS__
 *
 * 这样 index.js 里的静态文件逻辑只有一套，不用为打包单独分支。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 打包成 CJS 后 import.meta.url 是 undefined，这里两套兜底：
// 源码运行走 import.meta.url，打包版其实用不到目录（资源已内联）
function hereDir() {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return path.dirname(process.execPath);
  }
}
export const PUBLIC_DIR = path.resolve(hereDir(), '..', 'public');

/** 是否是打包后的单文件 exe */
export const PACKAGED = globalThis.__DANMU_PACKAGED__ === true;

const EMBEDDED = globalThis.__DANMU_ASSETS__ || null;

/** 归一化成 "style.css" / "sub/a.png" 形式；带 .. 的一律判非法 */
export function normalizeRel(p) {
  const rel = String(p || '')
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  if (!rel || rel.split('/').includes('..')) return null;
  return rel;
}

export function assetExists(rel) {
  if (!rel) return false;
  if (EMBEDDED) return Object.prototype.hasOwnProperty.call(EMBEDDED, rel);
  return fs.existsSync(path.join(PUBLIC_DIR, rel));
}

export function readAsset(rel) {
  if (!rel) return null;
  if (EMBEDDED) {
    const b64 = EMBEDDED[rel];
    return b64 ? Buffer.from(b64, 'base64') : null;
  }
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}
