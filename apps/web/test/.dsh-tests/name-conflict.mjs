/**
 * 验证：同一房间用同一个昵称重复加入，远端会怎么回。
 * 用法：node apps/web/test/.dsh-tests/name-conflict.mjs [房间号]
 */
import { RemotePlayer, sleep } from './remote-player.mjs';

const roomId = process.argv[2] ?? `dup${Math.floor(Math.random() * 9000 + 1000)}`;
const BASE = 'http://43.135.53.83:3000';
const NAME = '同名测试';

console.log(`房间「${roomId}」，两个客户端都用昵称「${NAME}」`);

const a = new RemotePlayer({ baseUrl: BASE, roomId, name: NAME });
await a.start({ ready: false });
await sleep(800);
console.log(`  A: 座位=${a.seat} 错误=${a.errors.length ? a.errors : '无'}`);

const b = new RemotePlayer({ baseUrl: BASE, roomId, name: NAME });
await b.start({ ready: false });
await sleep(1200);
console.log(`  B(同名): 座位=${b.seat} 错误=${b.errors.length ? b.errors : '无'}`);

// 再试一个不同昵称，确认房间本身还有空位
const c = new RemotePlayer({ baseUrl: BASE, roomId, name: `${NAME}2` });
await c.start({ ready: false });
await sleep(800);
console.log(`  C(不同名): 座位=${c.seat} 错误=${c.errors.length ? c.errors : '无'}`);

console.log('\n结论：');
if (b.errors.length && c.seat != null) {
  console.log('  ✅ 同名会被拒绝，但房间仍有空位 → 界面上应该显示"昵称已被占用"，而不是"牌局已坐满"');
} else if (c.seat == null) {
  console.log('  房间真的满了或加入被拒：', c.errors);
} else {
  console.log('  同名也能加入（远端允许多个同名）');
}

for (const x of [a, b, c]) x.close();
process.exit(0);
