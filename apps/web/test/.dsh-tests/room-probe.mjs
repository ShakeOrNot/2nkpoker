/**
 * 查询远端某个房间的真实占用情况（判断"牌局已坐满"是真是假）。
 * 用法：node apps/web/test/.dsh-tests/room-probe.mjs <房间号>
 */
import { RemotePlayer, sleep } from './remote-player.mjs';

const roomId = process.argv[2] ?? '5zbzme';
const BASE = 'http://43.135.53.83:3000';
const name = `诊断${Math.floor(Math.random() * 9000 + 1000)}`;

const p = new RemotePlayer({ baseUrl: BASE, roomId, name });
console.log(`用昵称「${name}」尝试加入房间「${roomId}」`);

try {
  await p.start({ ready: false });
} catch (err) {
  console.log('连接异常:', err.message);
}

await sleep(1500);

console.log('joinSuccess 座位:', p.seat);
console.log('joinFailed / errorMsg:', p.errors.length ? p.errors : '（无）');
console.log('收到的 playerList 人数:', p.players?.length ?? '（未收到）');

// RemotePlayer 目前只记 seat/hand/state，这里直接把游戏状态里的玩家列出来
if (p.state?.players) {
  for (const x of p.state.players) {
    console.log(`   座位${x.seat} ${x.name} 筹码${x.chips} 状态${x.status} ready=${x.ready}`);
  }
} else {
  console.log('（还没有 gameState；说明房间可能没人开局）');
}

p.close();
process.exit(0);
