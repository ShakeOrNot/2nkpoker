# 协议与接口约定

> 本文件以**当前代码**为准，不是目标设计。改协议时请同步改这里。
> 源码位置：`apps/game-server/src`、`packages/poker-engine/src`、`apps/web/public/js/net`。

## 1. 进程与端口

| 服务 | 默认端口 | 入口 | 作用 |
| :--- | :--- | :--- | :--- |
| game-server | 3001 | `apps/game-server/src/server.js` | Fastify HTTP + Socket.IO `/game` 命名空间 |
| web（开发服务器） | 8080 | `apps/web/dev-server.mjs` | 静态站 + 反向代理 |

一条命令同时起两个进程：`node start.mjs`（或双击 `启动.cmd`）。端口来自仓库根 `.env` 的 `PORT` / `WEB_PORT`，可用 `--game-port` / `--port` 覆盖。

`apps/web/dev-server.mjs` 会把 `/api/*`、`/socket.io/*`、`/tables*`、`/dev/*`、`/health`、`/ready` 代理到后端，所以浏览器里前后端同源，不需要 CORS。

## 2. 鉴权

- 算法：HS256；校验在 `apps/game-server/src/auth/jwt.js`
- 传输：**只有 Socket.IO 握手**用 `handshake.auth.token`；HTTP 接口目前不校验 JWT
- payload：`{ sub, nickname, role, iss, aud, exp }`
- `JWT_ISSUER` / `JWT_AUDIENCE` 默认 `2nkpoker` / `2nkpoker-web`，有效期 15 分钟
- 开发环境：`POST /dev/token` 由 game-server 自己签发（`NODE_ENV=production` 时不挂载该路由）
- 生产环境：由 auth 服务签发，game-server 只校验
- 校验失败：连接被拒绝，客户端收到 `connect_error.message === "AUTH_FAILED"`

## 3. HTTP 接口

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/health` | `{ ok: true, service: 'game-server' }` |
| GET | `/ready` | `{ ok: true }` |
| GET | `/tables` | `{ tables: TableSummary[] }`，新建的在前；空桌不列出（`POST /tables` 显式创建过的除外） |
| GET | `/tables/:tableId` | `{ ok: true, table: TableSummary }`；不存在时 404 + `{ ok: false, code: 'TABLE_NOT_FOUND' }` |
| POST | `/tables` | 创建/取回牌局，见下 |
| POST | `/dev/token` | 仅开发环境：`{ userId?, nickname? }` → `{ ok, token, userId, nickname }` |

`POST /tables` 请求体：

```json
{ "tableId": "abc123", "maxSeats": 6, "smallBlind": 10, "bigBlind": 20 }
```

- `tableId`：2~32 位 `[A-Za-z0-9_-]`，必填
- `maxSeats`：2~6（默认 6）
- 盲注：正整数（默认 10 / 20）
- 已存在时**直接返回现有牌局，不更新配置**；参数非法返回 400 + `INVALID_PAYLOAD`

```ts
type TableSummary = {
  tableId: string;
  players: number;      // 已入座人数
  maxSeats: number;
  hasHand: boolean;     // 是否有进行中的手牌
  smallBlind: number;
  bigBlind: number;
  createdAt: number;    // 毫秒时间戳
};
```

## 4. WebSocket（命名空间 `/game`）

### 4.1 客户端 → 服务端

| 事件 | 载荷 | ack 成功时额外返回 |
| :--- | :--- | :--- |
| `table:join` | `{ tableId }` | `seat`、`restored`（断线重连恢复原座位时） |
| `table:leave` | `{ tableId }` | —（只退订房间，不站起） |
| `table:sit` | `{ tableId, seat, buyIn }` | `seat`（`seat: -1` 表示任意空位） |
| `table:stand` | `{ tableId }` | — |
| `table:ready` | `{ tableId, ready }` | — |
| `table:request_state` | `{ tableId }` | `snapshot`（同时也会主动推一次 `table:snapshot`） |
| `game:action` | `{ tableId, handId, expectedVersion, action }` | — |

`action` 是一个判别联合（`apps/game-server/src/ws/validate.js`）：

```ts
type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; amount: number }    // 本街"下注到"多少，不是增量
  | { type: 'raise'; amount: number }  // 本街"加注到"多少，不是增量
  | { type: 'all_in' };
```

约定：

- 所有事件都有 ack：成功 `{ ok: true, ... }`，失败 `{ ok: false, code, message? }`
- `table:join` 只订阅房间，**不占座**；占座是 `table:sit`
- `table:sit` 对**已经在座的人**就是换座：不用先离座，筹码不变、`ready` 重置
  - 手牌进行中不允许换座（`HAND_IN_PROGRESS`）；目标座位有人返回 `SEAT_TAKEN`
- `table:stand` **只离座、不退出房间**：人还留在房间里当旁观者（仍收快照），可以立刻重新 `table:sit`
  - 真正退订房间是 `table:leave`（前端"返回大厅"= 离桌：先 stand 再 leave）
  - 手牌进行中调用不会立刻删座：服务端把座位标成 `leaving`（本手结束后清掉），
    轮到你的话当场弃牌，ack 返回 `{ ok: true, pending: true }`
  - `table:stand` 也可以取消排队
- 断线后 30 秒内（`RECONNECT_GRACE_MS`）用同一 JWT 重新 `table:join` 会恢复原座位
- 入座时如果这手牌还没结束，服务端返回 `{ ok: false, code: 'HAND_IN_PROGRESS', queued: true, seat: null }` 并把你放进等待队列：
  - 排队者**会**加入房间，能手牌期间观战（拿不到任何人的手牌）
  - 本手结束自动补位上桌（`ready: false`），随后正常 `table:ready` 参局
  - 断线会被自动移出队列

### 4.2 服务端 → 客户端

**只有这 5 个事件**（不存在 `game:street` / `game:showdown` / `hand:hole_cards` / `error`）：

| 事件 | 载荷 | 发给谁 |
| :--- | :--- | :--- |
| `table:snapshot` | `TableSnapshot` | 房间内每个 socket，按各自座位裁剪手牌 |
| `hand:start` | `{ handId, buttonSeat, smallBlind, bigBlind }` | 房间 |
| `game:action_request` | `{ handId, seat, legalActions, deadline, version }` | **只发给当前行动者** |
| `game:action_applied` | `{ seat, action, handId, timeout? }` | 房间 |
| `game:result` | `{ handId, result, board, seats }` | 房间 |

要点：

- 翻牌/转牌/河牌**没有专门事件**，街和公共牌只存在于 `table:snapshot.hand`（`street` + `board`）
- 服务端不会主动 emit `error`；失败一律走 ack 的 `code`
- 手牌只发本人：`hand.seats[].holeCards` 非本人座位恒为 `[]`
- `legalActions` 取值：`fold` / `check` / `call` / `bet` / `raise` / `all_in`

### 4.3 数据模型

```ts
type TableSnapshot = {
  tableId: string;
  version: number;        // 桌子版本，单调递增
  smallBlind: number;
  bigBlind: number;
  buttonSeat: number;
  maxSeats: number;
  seats: {                // 长度固定 = maxSeats，空位 userId 为 null
    seat: number;
    userId: string | null;
    nickname: string;
    chips: number;
    ready: boolean;
    connected: boolean;
    leaving: boolean;     // 手牌中点了离桌：本手结束后自动清座
  }[];
  hand: HandSnapshot | null;   // 没有进行中的手牌时为 null
};

type HandSnapshot = {
  handId: string;
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SETTLED';
  board: string[];        // 公共牌，如 ["As","Td","7c"]
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  seats: {
    seat: number;         // 只包含参与本手的座位，座位号可能不连续
    userId: string | null;
    nickname: string;
    chips: number;
    betThisStreet: number;   // 本街已下注，换街清零
    totalCommitted: number;  // 本手累计投入，从不重置
    folded: boolean;
    allIn: boolean;
    sittingOut: boolean;
    holeCards: string[];     // 只有本人能看到，其他人为 []
  }[];
  currentTurnSeat: number | null;
  currentBet: number;
  minRaise: number;
  pot: number;               // 本手总底池（含未收进池的下注）
  version: number;           // 手牌版本，game:action 的 expectedVersion 校验它
  settled: boolean;
  result: HandResult | null;
};

type HandResult = {
  pots: { amount: number; eligibleSeats: number[]; contributorSeats: number[] }[];   // 每层独立，不合并
  payouts: Record<number, number>;    // 座位号 -> 赢得筹码，只有赢家出现
  revealed: Record<number, string[]>; // 摊牌时亮出的手牌
  forcedWinnerSeat: number | null;    // 只剩一人时的强制赢家
};
```

## 5. 错误码

服务端产生的码（ack 里的 `code`）：

| 码 | 场景 | 前端文案（`core/constants.js`） |
| :--- | :--- | :--- |
| `AUTH_FAILED` | 握手 token 缺失/非法/过期 | 登录已失效，请重新登录 |
| `INVALID_PAYLOAD` | zod 校验失败（字段缺失/越界） | 请求格式不对，请刷新页面重试 |
| `TABLE_NOT_FOUND` | 牌局不存在 | 牌局不存在，可能已被解散 |
| `TABLE_FULL` | 没有空座位 | 牌局已坐满，换个牌局试试 |
| `ALREADY_SEATED` | 已经坐在这张桌子（普通入座路径才会出现；已入座时 `table:sit` 被当作换座） | 你已经在这张牌局里了 |
| `SEAT_TAKEN` | 换座的目标座位已经有人 | 该座位已被占用 |
| `SEAT_INVALID` | 换座的目标座位号越界 | 座位号非法 |
| `ALREADY_IN_OTHER_TABLE` | 已坐在别的桌子 | 你已经在另一张桌子上了 |
| `NOT_SEATED` | 没坐下就发动作/准备 | 你还没有入座 |
| `HAND_IN_PROGRESS` | 手牌进行中不能入座/换座/准备；`queued: true` 表示已排队 | 牌局进行中，暂时不能入座或离座 |
| `INVALID_BUY_IN` | 带入不在 100~100000 | 带入筹码必须在 100~100000 之间 |
| `HAND_NOT_ACTIVE` | 没有进行中的手牌 | 当前没有进行中的牌局 |
| `STATE_OUTDATED` | `expectedVersion` 与服务端不一致 | 牌局状态已更新，请重试 |
| `NOT_YOUR_TURN` | 不是当前行动者（引擎抛出） | 还没轮到你行动 |
| `INVALID_ACTION` | 动作类型/金额不合法（引擎抛出） | 这个操作现在不允许 |
| `INSUFFICIENT_CHIPS` | 筹码不足（引擎抛出） | 筹码不足 |
| `NETWORK` / `NOT_CONNECTED` | 前端本地码：ack 超时 / 未连接 | 连不上服务器 / 还没有连上服务器 |

说明：

- `RATE_LIMITED`、`INTERNAL_ERROR` 目前**服务端不下发**（前端文案保留，方便将来限流）
- 引擎的 `ActionError` 直接当作 `code` 透传，message 可能为空

## 6. 规则要点

- **金额一律整数**，`bet` / `raise` 的 `amount` 是"本街下注到的总额"，不是增量
- **版本号**：`game:action` 带上 `expectedVersion = hand.version`，不一致直接被拒（`STATE_OUTDATED`）
- **座位号不要求连续**：6 个固定座位里有人输光离座会留下空洞（例如只剩 0、2、4），引擎照常开局，按钮位顺时针顺延
- **座位号只发本人手牌**；服务端权威，客户端发的是意图不是结果
- **短 all-in**：加注幅度 < `minRaise` 时不重置别人的 `hasActedThisStreet`，但已下注不足的玩家仍需行动一次
- **超时**：`ACTION_TIMEOUT_MS`（默认 30s）到点自动 check/fold；掉线玩家、以及已经点了"本手结束后离桌"的玩家，在轮次上只等 100ms 就被代打
- **断线**：`RECONNECT_GRACE_MS`（默认 30s）内回来可以恢复；超时后不在局中就离座，在局中则保留座位到本手结束、`ready` 置 false 不再自动参与
- **连续开局**：一手结算后停 `SETTLE_HOLD_MS`（默认 2.5s，给前端放结算浮层/动画）再尝试开下一手；期间有人离座/取消准备则自然不开

## 7. 动画时机（给前端/视觉）

| 事件 | 建议动画 |
| :--- | :--- |
| `hand:start` | 洗牌、发牌 |
| `table:snapshot` 里 `hand.handId` 首次出现 | 自己的两张手牌翻开 |
| `table:snapshot` 里 `board` 由 0→3 / 3→4 / 4→5 | 翻牌 / 转牌 / 河牌 |
| `game:action_applied` | 筹码飞向底池 |
| `game:result` | 亮牌、筹码飞向赢家、结算浮层 |

## 8. 引擎与共享库

`@2nkpoker/poker-engine`（纯函数，可单独测试）与 `@2nkpoker/shared`：

### 位置（`poker-engine/positions.js`）

- `Position`：BTN / SB / BB / UTG / HJ / CO
- `positionsFor(n)` → 位置名数组，n ∈ [2, 6]
- `positionOf(seat, buttonSeat, n)`
- `seatPositions(buttonSeat, n)` → Map<seat, position>
- `preflopOrder(buttonSeat, n, seatRing?)` → 座位号数组，翻前行动顺序
- `postflopOrder(buttonSeat, n, seatRing?)` → 座位号数组，翻后行动顺序
- `nextOccupiedSeat(seats, fromSeat)` → 顺时针下一个有人坐的座位（绕回最小座位）

> 座位号**不要求连续**。真实桌子是 6 个固定座位，有人输光离座/换座后座位号会留下空洞
> （例如只剩 0、2、4 三个人）。`startHand` 只要求座位号唯一，按钮位不在任何人身上时
> 会自动顺时针顺延；行动顺序类函数接受可选的 `seatRing`（有人坐的真实座位号数组），
> 不传时按连续的 `0..n-1` 计算，行为与旧版一致。

### 底池（`poker-engine/pot.js`）

- `buildPots(contributions)` → `Pot[]`，每层独立，**不合并**
  - `contributions`: `[{ seat, amount, folded }]`
  - `Pot`: `{ amount, eligibleSeats: number[], contributorSeats: number[] }`
  - `contributorSeats` 含**已弃牌**的出资者，用于孤池退款
- `totalPot(pots)`
- `awardPots(pots, handStrengthBySeat)`
  - 每层独立找 eligibleSeats 中牌力最高者
  - 多人并列 → 平分；余数给**座位号最小**的赢家
  - 某层 `eligibleSeats` 为空（没人有资格争）→ 按人头**退还给该层出资者**，不会凭空消失
  - 返回 `Map<seat, chips>`，只包含拿到筹码的座位（含退款）
  - 不变式：`sum(payouts) === totalPot(pots)`，随机对局测试里有断言

### 下注快捷（`poker-engine/betSizing.js`）

- `BetFraction`：`THIRD=1/3`、`HALF=0.5`、`TWO_THIRDS=2/3`、`FULL=1`、`ONE_POINT_TWO=1.2`
- `calcBetSize({ pot, fraction, currentBet, myBetThisStreet, chips, minRaise, bigBlind })`
  - 返回 `{ type: 'bet'|'raise', amount, capped, isAllIn, fraction }`
  - 无人下注 → `raise_to = round(fraction * pot)`，下限 bigBlind
  - 有人下注 → `raise_to = round(currentBet + fraction * (pot + 2 * toCall))`，下限 currentBet + minRaise

### 行动合法性（`poker-engine/actions.js`）

- `legalActions(state, seat)` → 类型数组
- `validateAction(state, seat, action)` → `{ pay, isRaise, isAllIn }` 或抛 `ActionError`
- `ActionError`：`NOT_YOUR_TURN` / `INVALID_ACTION` / `INSUFFICIENT_CHIPS` / `HAND_NOT_ACTIVE` / `SEAT_INVALID`

### 格式化（`shared/format.js`）

- `potPercent(amount, pot)` → `"50%"`、`"120%"`
- `formatChips(n)` → `"1.2k"`、`"1.5m"`
- `formatDuration(ms)` → `"30s"`、`"1m"`

### HandState 字段分工

| 字段 | 含义 | 何时重置 |
| :--- | :--- | :--- |
| `betThisStreet` | 本街已下注 | **换街时** 清零 |
| `totalCommitted` | 本手累计投入 | 从不重置，摊牌后用于 `buildPots` |
| `chips` | 剩余筹码 | 递减 |
| `hasActedThisStreet` | 本街是否已行动 | 换街或**合法加注**时重置 |

## 9. 已知限制（尚未实现，别照着写前端）

| 限制 | 影响 | 位置 |
| :--- | :--- | :--- |
| 没有 Redis 持久化 | 服务重启后牌局/筹码全部丢失（纯内存） | `state/tableManager.js` |
| 没有限流 | `RATE_LIMITED` 只是预留码 | — |
| 前端复制了一份引擎逻辑 | `apps/web/public/js/core/logic.js` 与 `poker-engine` 各自演进，存在漂移风险 | `core/logic.js` |
