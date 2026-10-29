# 协议与接口约定

> 本文件以**当前代码**为准，不是目标设计。改协议时请同步改这里。
> 源码位置：`apps/game-server/src`、`packages/poker-engine/src`、`apps/web/public/js/net`。

## 1. 进程与端口

| 服务 | 默认端口 | 入口 | 作用 |
| :--- | :--- | :--- | :--- |
| game-server | 3001 | `apps/game-server/src/server.js` | Fastify HTTP + Socket.IO `/game` 命名空间 |
| web（开发服务器） | 8080 | `apps/web/dev-server.mjs` | 静态站 + 反向代理 |

一条命令同时起两个进程：`node start.mjs`（或双击 `启动.cmd`）。端口来自仓库根 `.env` 的 `PORT` / `WEB_PORT`，可用 `--game-port` / `--port` 覆盖。

`apps/web/dev-server.mjs` 会把 `/api/*`、`/socket.io/*`、`/tables*`、`/auth/*`、`/dev/*`、`/health`、`/ready` 代理到后端，所以浏览器里前后端同源，不需要 CORS。

> 上公网时后端一般放在 Nginx/Caddy 后面，此时要在 `.env` 里设 `TRUST_PROXY=1`（或 `loopback`），否则 Fastify 只看到代理的 IP：登录限流会把所有用户算成同一个 IP，审计日志里的 IP 也没意义。

## 2. 鉴权

### 2.1 账号口令

- **昵称即登录名**：注册时昵称唯一（ASCII 大小写不敏感），2~20 个字符，只能用字母/数字/`_`/`-`/中文
- 口令用 `scrypt`（N=2^15, r=8, p=1，随机 16B salt）哈希后存 SQLite，**不存明文**
- 用户库：`var/2nkpoker.db`（`AUTH_DB_PATH` 可改，`var/` 已被 gitignore）
- 口令策略：≥8 位、≤72 位、不能纯数字、不能和昵称相同
- 失败限制：同账号 5 次失败锁 5 分钟；同 IP 5 分钟内最多 20 次失败（内存实现，单进程）
- 账号被禁用时登录返回 `AUTH_DISABLED`

### 2.2 令牌

- access token：JWT HS256，**15 分钟**，payload `{ sub, nickname, role, tv, iss, aud, exp }`
  - `sub` = 用户 id（uuid）；`tv` = 账号 token_version（改密/重置后 +1，旧令牌立即失效）
- refresh token：32 字节随机串，DB 只存 sha256，**7 天**；每次刷新轮换，**旧令牌用过再来直接撤销该账号全部刷新令牌**（盗用检测）
- 传输：Socket.IO 握手用 `handshake.auth.token`（access token）；HTTP 鉴权接口用 `Authorization: Bearer <access>`
- 校验：`auth/jwt.js`（签名/签发方/受众/过期）；`/auth/me` 与 `/auth/refresh` 额外校验 `tv` 与禁用状态
- 改密/管理员重置：`token_version + 1` + 撤销全部刷新令牌 → 其它设备需重新登录
- 开发环境：`POST /dev/token` 仍可用（`NODE_ENV=production` 或 `ALLOW_DEV_TOKEN=0` 时关闭），签"无名令牌"给脚本/联调用
- 校验失败：连接被拒绝，客户端收到 `connect_error.message === "AUTH_FAILED"`

### 2.3 管理员接口

管理员身份只存在数据库 `users.role` 里，没有"注册即管理员"的入口；提权用运维脚本
`node apps/game-server/scripts/reset-password.mjs --make-admin <昵称>`（降回普通账号用 `--make-user`）。

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/auth/admin/users?q=&limit=&offset=` | 账号列表：昵称模糊搜索（`q` ≤40 字符）、`limit` 1~200（默认 50）、`offset` ≥0 → `{ ok, total, users }` |
| PATCH | `/auth/admin/users/:id` | `{ role?: 'user'|'admin', disabled?: boolean }`（至少一项）→ `{ ok, user }` |
| POST | `/auth/admin/reset-password` | `{ nickname, newPassword }` → `{ ok: true }` |
| GET | `/auth/admin/audit?limit=` | 审计日志（`limit` 1~200，默认 50，按时间倒序）→ `{ ok, entries }` |

规则：

- 四个接口都要 `Authorization: Bearer <access>` 且 `role=admin`，否则 403 `FORBIDDEN`（并写一条 `admin-denied` 审计）
- 不能修改自己（400 `CANNOT_MODIFY_SELF`，改自己请走 `/auth/change-password`）
- 不能把最后一个启用的管理员降权/禁用（400 `LAST_ADMIN`）
- 改角色 / 禁用 / 重置口令都会 `token_version + 1` 并撤销该账号全部 refresh token，目标需要重新登录
- 被禁用账号的旧 access 调 `/auth/me` 返回 403 `AUTH_DISABLED`
- 审计条目字段：`{ at: number（毫秒）, action, nickname, ip, ok: boolean }`；`action` 目前有 `register` `login` `login-failed` `refresh` `logout` `change-password` `admin-reset` `admin-update` `admin-denied`
- 前端入口：大厅右上角「管理」（仅 `user.role === 'admin'` 可见），对应视图 `views/admin.js`

## 3. HTTP 接口

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/health` | `{ ok: true, service: 'game-server' }` |
| GET | `/ready` | `{ ok: true }` |
| POST | `/auth/register` | `{ nickname, password }` → 会话（见下） |
| POST | `/auth/login` | `{ nickname, password }` → 会话 |
| POST | `/auth/refresh` | `{ refreshToken }` → 新的一对令牌（旧 refresh 作废） |
| POST | `/auth/logout` | `{ refreshToken }` → `{ ok: true }` |
| GET | `/auth/me` | `Authorization: Bearer <access>` → `{ ok, user }` |
| POST | `/auth/change-password` | `{ oldPassword, newPassword }`（需 Bearer）→ 新会话 |
| POST | `/auth/admin/reset-password` | `{ nickname, newPassword }`（需 Bearer + `role=admin`）→ `{ ok: true }` |
| GET | `/auth/admin/users` | 管理员账号列表，见 2.3 |
| PATCH | `/auth/admin/users/:id` | 管理员改角色/禁用，见 2.3 |
| GET | `/auth/admin/audit` | 审计日志，见 2.3 |
| GET | `/tables` | `{ tables: TableSummary[] }`，新建的在前；空桌不列出（`POST /tables` 显式创建过的除外） |
| GET | `/tables/:tableId` | `{ ok: true, table: TableSummary }`；不存在时 404 + `{ ok: false, code: 'TABLE_NOT_FOUND' }` |
| POST | `/tables` | 创建/取回牌局，见下 |
| POST | `/dev/token` | 仅开发环境：`{ userId?, nickname? }` → `{ ok, token, userId, nickname }` |

会话响应（register/login/refresh/change-password 成功时）：

```ts
{
  ok: true,
  accessToken: string,      // JWT，15 分钟
  refreshToken: string,     // 7 天，轮换使用
  expiresAt: number,        // access 过期时间（毫秒）
  user: { id: string, nickname: string, role: 'user'|'admin', createdAt: number, lastLoginAt: number|null }
}
```

失败统一 `{ ok: false, code, message?, retryAfterMs? }`，HTTP 状态：400 参数/弱口令、401 凭据错误/令牌失效、403 禁用、409 昵称已存在、429 锁定/限流。

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
| `AUTH_FAILED` | 握手 token 缺失/非法/过期；HTTP 鉴权失败 | 登录已失效，请重新登录 |
| `AUTH_EXPIRED` | access token 过期 | 登录已过期，请重新登录 |
| `AUTH_INVALID_CREDENTIALS` | 昵称不存在 / 口令不对（统一文案，不暴露区别） | 昵称或口令不对 |
| `AUTH_USER_EXISTS` | 注册时昵称已被占用 | 这个昵称已经被注册了 |
| `AUTH_WEAK_PASSWORD` | 口令不满足策略 / 新旧口令相同 | 口令太弱：至少 8 位，不能纯数字，也不能和昵称相同 |
| `AUTH_INVALID_NICKNAME` | 昵称不符合规则 | 昵称需 2~20 个字符，只能用字母/数字/下划线/中划线/中文 |
| `AUTH_LOCKED` | 失败次数过多被临时锁定（429） | 失败次数过多，账号已临时锁定，稍后再试 |
| `AUTH_REFRESH_INVALID` | 刷新令牌无效/过期/被轮换作废 | 登录已失效，请重新登录 |
| `AUTH_CREDENTIALS_CHANGED` | 口令已变更，旧 access token 失效 | 口令已变更，请重新登录 |
| `AUTH_DISABLED` | 账号被管理员禁用 | 账号已被禁用，请联系管理员 |
| `FORBIDDEN` | 普通账号调用了管理员接口 | 你没有权限做这个操作 |
| `USER_NOT_FOUND` | 管理员操作的目标账号不存在 | 没有这个账号 |
| `CANNOT_MODIFY_SELF` | 管理员对自己执行改角色/禁用 | 不能修改自己的账号（改自己请用「改口令」） |
| `LAST_ADMIN` | 会消灭最后一个启用管理员的降权/禁用 | 至少要保留一个管理员 |
| `RATE_LIMITED` | 同 IP 失败过于频繁（429） | 操作太快了，稍等一下 |
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

- `INTERNAL_ERROR` 目前**服务端不下发**（前端文案保留）
- 引擎的 `ActionError` 直接当作 `code` 透传，message 可能为空
- 登录失败限流/锁定的参数见环境变量 `AUTH_MAX_ATTEMPTS` / `AUTH_LOCK_MS` / `AUTH_IP_MAX_ATTEMPTS`

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
