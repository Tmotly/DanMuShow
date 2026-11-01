/**
 * 打包成单文件 exe（Node SEA）。
 *
 * 为什么这么绕：
 * - pkg / nexe 都要从 GitHub 下载预编译的 Node 二进制，国内网络经常拉不动；
 * - SEA 是 Node 官方能力，只用本机 node.exe + 官方 postject 注入，不下载任何东西；
 * - SEA 只接受 CommonJS 入口，所以先把整个 ESM 项目打成单文件 CJS，
 *   前端静态资源以 base64 内联进 globalThis.__DANMU_ASSETS__。
 *
 * 为什么用 esbuild 的 CLI 而不是 JS API：
 * JS API 要走管道和常驻子进程通信，在受限环境（比如 DSH 沙箱）里会 EPERM。
 * CLI + stdio inherit 不建管道，哪都能跑。找不到二进制时自动退回 JS API。
 *
 * 用法：npm run pack
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { inject } from 'postject';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN = path.join(ROOT, 'build', 'gen');
const DIST = path.join(ROOT, 'dist');
const EXE = path.join(DIST, 'DanMuShow.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const step = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);

/** 递归收集 public/ 下的文件，转成 { 相对路径: base64 } */
function collectAssets(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectAssets(full, base, out);
    else if (entry.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join('/');
      out[rel] = fs.readFileSync(full).toString('base64');
    }
  }
  return out;
}

/** 找到 esbuild 的原生二进制（跨平台） */
function findEsbuildBin() {
  const pkg = `@esbuild/${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  try {
    const req = createRequire(import.meta.url);
    const dir = path.dirname(req.resolve(`${pkg}/package.json`));
    const bin = path.join(dir, exe);
    if (fs.existsSync(bin)) return bin;
  } catch {
    // 换下面的兜底
  }
  return null;
}

fs.rmSync(GEN, { recursive: true, force: true });
fs.mkdirSync(GEN, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

/* 1. 前端资源内联 */
const assets = collectAssets(path.join(ROOT, 'public'));
step(`收集前端资源 ${Object.keys(assets).length} 个`);

fs.writeFileSync(
  path.join(GEN, 'assets-global.js'),
  `// 构建产物，勿手改\nglobalThis.__DANMU_PACKAGED__ = true;\nglobalThis.__DANMU_ASSETS__ = ${JSON.stringify(assets)};\n`,
  'utf8',
);

/* 2. 入口：先挂资源，再加载服务（顺序不能反） */
const entry = path.join(GEN, 'entry.js');
fs.writeFileSync(
  entry,
  `import './assets-global.js';\nimport ${JSON.stringify(path.join(ROOT, 'server/index.js').replace(/\\/g, '/'))};\n`,
  'utf8',
);

/* 3. 打成单文件 CJS */
step('打包 JS 中…');
const outfile = path.join(GEN, 'app.cjs');
const bin = findEsbuildBin();
if (bin) {
  // stdio: inherit —— 不建管道，受限环境也能跑
  const r = spawnSync(
    bin,
    [
      entry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node18',
      '--log-level=warning',
      '--log-override:empty-import-meta=silent',
      '--legal-comments=none',
      '--external:bufferutil',
      '--external:utf-8-validate',
      `--outfile=${outfile}`,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (r.status !== 0) {
    console.error('esbuild 打包失败');
    process.exit(1);
  }
} else {
  const esbuild = await import('esbuild').then((m) => m.default ?? m);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile,
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    logLevel: 'warning',
  });
}
step(`bundle 完成：${(fs.statSync(outfile).size / 1024).toFixed(0)} KB`);

/* 4. 生成 SEA blob */
step('生成 SEA blob…');
const seaConfig = path.join(GEN, 'sea-config.json');
const blobPath = path.join(GEN, 'app.blob');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: outfile, output: blobPath, disableExperimentalSEAWarning: true }, null, 2),
  'utf8',
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

/* 5. 复制 node.exe 并注入 */
step('注入到 node.exe 副本…');
fs.copyFileSync(process.execPath, EXE);
await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), { sentinelFuse: FUSE });

const mb = (fs.statSync(EXE).size / 1048576).toFixed(1);
step(`\x1b[32m完成\x1b[0m  ${EXE}  (${mb} MB)`);
console.log('\n直接双击就能跑；配置文件写在 %LOCALAPPDATA%\\DanMuShow\\config.json');
console.log('想做绿色版：把 config.json 放到 exe 同目录即可。\n');
