// 工具脚本共用：项目根目录、可选的 jsdom 加载
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * jsdom 不是运行时依赖，只有几个前端测试要用。
 *   npm i -D jsdom          # 装了就正常跑
 *   JSDOM_PATH=/some/dir    # 或者指向任意一个已经装了 jsdom 的目录
 * 两样都没有就返回 null，调用方跳过测试即可，不报错。
 */
export function loadJSDOM() {
  const bases = [import.meta.url];
  if (process.env.JSDOM_PATH) {
    bases.push(path.join(process.env.JSDOM_PATH, 'noop.js'));
  }
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const mod = req('jsdom');
      if (mod?.JSDOM) return mod;
    } catch {
      // 继续试下一个
    }
  }
  return null;
}

/** 统一的「没有 jsdom 就优雅跳过」 */
export function requireJSDOM() {
  const mod = loadJSDOM();
  if (!mod) {
    console.log('跳过：没有安装 jsdom（npm i -D jsdom，或设置 JSDOM_PATH 指向已安装目录）');
    process.exit(0);
  }
  return mod;
}
