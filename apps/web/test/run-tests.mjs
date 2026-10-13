#!/usr/bin/env node
/**
 * 前端测试运行器（零依赖）。
 *
 * 仓库根目录的 node_modules 是在别的机器上装的，本机依赖树不完整，
 * 所以这里做了两件事让测试照样能跑：
 *   1. 用 .dsh-tests/vitest-shim.mjs 顶替 vitest；
 *   2. 给 Node 装上最小浏览器桩（localStorage / document / window）。
 *
 * 用法：node apps/web/test/run-tests.mjs
 */

import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('.', import.meta.url);
const here = dir.pathname.replace(/^\/([A-Za-z]:)/, '$1');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vitest') {
      return { url: pathToFileURL(join(here, '.dsh-tests', 'vitest-shim.mjs')).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

await import(pathToFileURL(join(here, '.dsh-tests', 'fake-browser.mjs')).href);

const { report } = await import(pathToFileURL(join(here, '.dsh-tests', 'vitest-shim.mjs')).href);

const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

console.log(`前端测试：${files.length} 个文件`);
for (const file of files) {
  try {
    await import(pathToFileURL(join(here, file)).href);
  } catch (err) {
    console.error(`  LOAD FAIL ${file}: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

const failed = await report('前端测试');
process.exit(failed === 0 && !process.exitCode ? 0 : 1);
