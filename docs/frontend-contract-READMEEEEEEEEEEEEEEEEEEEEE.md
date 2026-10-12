# 前端契约

给 C/D 用。所有接口在 Day 7 稳定。

## 连接

```js
const socket = io('http://localhost:3001/game', {
  auth: { token: '<JWT>' },
});
```

生产环境：`io('https://2nkpoker.com/game', { auth: { token } })`。

**token 获取（仅开发环境）**：

```bash
curl -X POST http://localhost:3001/dev/token \
  -H "Content-Type: application/json" \
  -d '{"nickname":"Tom"}'
```

生产环境由 A 那边的 `/auth/login` 签发。

## 事件总览

### 客户端 → 服务端

| 事件 | 载荷 | 说明 |
|---|---|---|
| `table:join` | `{ tableId }` | 订阅房间（观战/入座前） |
| `table:sit` | `{ tableId, seat, buyIn }` | 入座（buyIn 100~100000） |
| `table:stand` | `{ tableId }` | 离座 |
| `table:ready` | `{ tableId, ready }` | 准备 / 取消准备 |
| `game:action` | `{ tableId, handId, expectedVersion, action }` | 发动作 |

所有事件都带 ack 回调：

```js
socket.emit('table:sit', {...}, (res) => {
  if (res.ok) { /* 成功 */ }
  else { /* res.code / res.message */ }
});
```

### 服务端 → 客户端

| 事件 | 载荷 | 频率 |
|---|---|---|
| `table:snapshot` | `TableSnapshot` | 每次状态变化 |
| `hand:start` | `{ handId, buttonSeat, smallBlind, bigBlind }` | 一手开始时 |
| `game:action_request` | `{ handId, seat, legalActions, deadline }` | **只发给当前行动者** |
| `game:action_applied` | `{ seat, action, handId, timeout? }` | 每次动作 |
| `game:result` | `{ handId, result, board }` | 摊牌时 |

## TableSnapshot 结构

```ts
{
  tableId: string;
  version: number;          // 桌子版本，不含 hand
  smallBlind: number;
  bigBlind: number;
  buttonSeat: number;
  maxSeats: number;         // 6
  seats: Array<{
    seat: number;
    userId: string | null;  // null = 空座
    nickname: string;
    chips: number;
    ready: boolean;
    connected: boolean;     // 断线时为 false
  }>;
  hand: null | {
    handId: string;
    street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SETTLED';
    board: string[];        // ['9c','5h','Qc']，Card 类型
    buttonSeat: number;
    smallBlind: number;
    bigBlind: number;
    seats: Array<{
      seat: number;
      userId: string | null;
      nickname: string;
      chips: number;
      betThisStreet: number;
      totalCommitted: number;
      folded: boolean;
      allIn: boolean;
      sittingOut: boolean;
      holeCards: string[];  // 只有本人有牌，其他人 []
    }>;
    currentTurnSeat: number | null;
    currentBet: number;
    minRaise: number;
    pot: number;            // 底池总额
    version: number;        // hand 版本，发动作时带
    settled: boolean;
    result: null | {
      pots: Array<{ amount: number; eligibleSeats: number[] }>;
      payouts: Record<number, number>;   // seat -> chips
      revealed: Record<number, string[]>;
      forcedWinnerSeat: number | null;
    };
  };
}
```

**Card 格式**：`rank + suit`，例如 `"As"`、`"Td"`、`"2h"`。
- rank: `2 3 4 5 6 7 8 9 T J Q K A`
- suit: `s h d c`（黑红方梅）

## 动作流程

前端典型流程：

1. `connect` → `table:join`（订阅房间）
2. `table:sit`（点"坐下"）
3. `table:ready: true`（点"准备"）
4. 服务端自动开局，前端收到 `hand:start` + `table:snapshot`
5. 收到 `game:action_request`：
   - **记住 `deadline` 和 `handId`**
   - **记住 `hand.version`**（来自最近的 `table:snapshot.hand.version`）
   - 用户点按钮后 `game:action` 带上 `handId` 和 `expectedVersion`
6. 收到 `game:action_applied`：播放动画（筹码飞向底池）
7. 收到 `game:result`：亮牌 + 结算动画
8. 服务端把 `hand` 置 null，前端回到大厅态

## 关键约定

- **手牌只发给本人**：`snapshot.hand.seats[i].holeCards` 只有本座非空
- **expectedVersion 必须来自最新快照**：过期会被拒（`STATE_OUTDATED`）
- **超时自动动作**：`game:action_applied` 会带 `timeout: true`
- **断线重连**：30 秒内重连 `table:join`，服务端会恢复座位并广播 `connected: true`
- **`amount` 语义**：
  - `bet` / `raise` 的 `amount` 是**目标金额**（本街下注到多少），不是增量
  - `raise` 的 `amount` 必须 ≥ `snapshot.hand.currentBet + snapshot.hand.minRaise`

## 错误码

见 `docs/error-codes.md`。前端常用：

| 码 | 场景 |
|---|---|
| `NOT_YOUR_TURN` | 不是你的回合 |
| `STATE_OUTDATED` | 用旧版本发动作 |
| `INVALID_ACTION` | 动作非法 |
| `HAND_NOT_ACTIVE` | 手牌已结束 |
| `ALREADY_SEATED` | 已在座位上 |
| `TABLE_FULL` | 桌子满 |
| `HAND_IN_PROGRESS` | 一手进行中，不能入座/离座 |

## 前端工具推荐

从 `@2nkpoker/poker-engine` import：

- `BetFraction`：快捷下注比例常量
- `calcBetSize({...})`：算加注到多少
- `legalActions(state, seat)`：算合法动作（也可以直接用服务端发来的 `legalActions`）
- `potPercent(amount, pot)`（来自 `@2nkpoker/shared`）：显示百分比

## 本地开发

1. 启动后端：`pnpm -F game-server dev`
2. 拿 token：见上文
3. 前端连 `http://localhost:3001/game`