# 后端待补接口清单（前端已按此写好，接上即可生效）

> 需求来源：前端要做到「登录 → 创建牌局 / 加入牌局 → 牌局已开始则在等待室等待 → 牌桌 → 结算」。
> 现在的后端只支持"用 tableId 即用即建 + 全局写死盲注 10/20"，所以缺三块：**牌局列表、创建牌局（含配置）、进行中入座的等待语义**。
> 前端已经全部按下面的契约写好并做了降级，**接口没上也不会白屏**，只是能力受限（见文末"当前降级行为"）。

---

## 1. 需要新增的 HTTP 接口

### 1.1 牌局列表（必须）

```
GET /tables
```

响应（字段已做多命名兼容，任选其一即可，前端都能解析）：

```json
{
  "tables": [
    {
      "tableId": "abc123",
      "players": 3,
      "maxSeats": 6,
      "hasHand": true,
      "smallBlind": 10,
      "bigBlind": 20,
      "createdAt": 1791700000000
    }
  ]
}
```

也可以直接返回数组 `[ {...} ]`。

**字段说明**

| 字段 | 类型 | 说明 | 前端兼容别名 |
|---|---|---|---|
| `tableId` | string | 牌局 ID | `roomId` / `id` |
| `players` | number | 已入座人数 | `seated` / `seatCount` |
| `maxSeats` | number | 座位上限，默认 6 | — |
| `hasHand` | boolean | 是否正在一手牌中（决定列表显示"进行中"） | `inHand` |
| `smallBlind` / `bigBlind` | number | 盲注 | — |
| `createdAt` | number | 创建时间（毫秒），用于排序与"x 分钟前" | — |

前端拿到列表后会用 `tableId` 调 `table:join` 加入，所以**列表里的 ID 必须是真实存在的桌子**（当前后端是"用到即建"，所以任何合法 ID 都能进）。

---

### 1.2 创建牌局（可选，但强烈建议）

```
POST /tables
Content-Type: application/json

{ "tableId": "abc123", "maxSeats": 6, "smallBlind": 10, "bigBlind": 20 }
```

响应：`200 { "ok": true, "table": { "tableId": "abc123", ... } }`（返回什么前端都不强依赖）

**为什么要这个接口**：前端"创建牌局"面板允许选座位数（2~6）和盲注档位（10/20、25/50、50/100、100/200），但 `tableManager.getOrCreateTable()` 现在把这些写死：

```js
smallBlind: 10,
bigBlind: 20,
maxSeats: 6,
```

让创建接口把配置存进 `Table`，`table:join` 时读回即可：

```js
// 建议：tableManager 增加 createTable(tableId, { maxSeats, smallBlind, bigBlind })
// 并用一个 Set/Map 记录"显式创建过的桌子"（避免被 removeTableIfEmpty 清掉后配置丢失）
```

**前端已做的兼容**：即使没有这个接口，前端也会先生成一个房号、把配置存在本机（`localStorage`），并照常用 `table:join` 开局——只是盲注实际仍是后端的 10/20。`POST /tables` 返回成功后前端不再提示降级。

---

### 1.3 单个牌局详情（可选）

```
GET /tables/:tableId
```

用途：分享链接打开时先校验牌局是否存在，避免进到空桌子。没有也能用（前端直接 `table:join`）。

---

## 2. 需要确认/补充的 WebSocket 语义

### 2.1 进行中入座 → 等下一手（**最关键**）

现在的行为：

```js
// apps/game-server/src/ws/handlers/table.sit.js
if (t.handState && !t.handState.settled) {
  return replyAck(ack, { ok: false, code: 'HAND_IN_PROGRESS', message: 'hand in progress' });
}
```

**前端已经按这个行为做好了等待室**：
- 牌局进行中时，`table:join` 照常订阅房间、能看快照（观战）；
- 点"坐下"会收到 `HAND_IN_PROGRESS`，前端提示"牌局进行中，本手结束后可入座"，并在等待室实时显示阶段/底池/公共牌/仍在局中的人；
- 一旦这手结束、快照里 `hand` 变成 `null` 或 `settled`，等待室的"坐下"按钮自动恢复可用。

**如果你希望改成"排进下一手"**，需要补的是：
1. `table:sit` 在 `HAND_IN_PROGRESS` 时仍返回 `ok: false`，但增加 `queue: true` 字段；或
2. 新增事件 `table:queue { tableId, seat?, buyIn }`，服务端在一手结算（`cleanupAfterHand` 之后）自动把排队的人放上座位并广播快照。

前端改动量很小（等待室加一个"排队等下一手"按钮），告诉我采用哪种即可。

### 2.2 `table:leave`

`docs/protocol.md` 里列了 `table:leave`，`validate.js` 里也有 `TableLeaveSchema`，但**没有任何 handler 监听它**（现在只有 `table:stand` 会离座）。如果语义是"退订房间（不一定离座）"，建议补：

```js
socket.on('table:leave', (payload, ack) => {
  socket.leave(`table:${payload.tableId}`);
  socket.data.tableId = undefined;
  ack({ ok: true });
});
```

### 2.3 `table:request_state`

协议文档里写了（`{ tableId, lastVersion? }`），代码里没有。手机端切回前台时很有用（前端目前靠 `table:snapshot` 全量推送兜底，已能用）。

### 2.4 建议在 `game:action_request` 里带上 `version`

前端发 `game:action` 必须带 `expectedVersion`。现在它只能从"最近一次快照"里取：

```js
// actionTimer.js 现在发的是
sock.emit('game:action_request', { handId, seat, legalActions, deadline });
```

建议加上 `version: t.handState.version`，前端就能用它当 `expectedVersion`，减少"快照还没到就点了按钮"导致的 `STATE_OUTDATED`。（前端已兼容：优先用快照版本，没有才用请求里的。）

### 2.5 建议在快照里带上上一手的净变化

牌桌现在结算后靠前端自己算 `chips - (chips - payout + committed)`。如果服务端直接在 `hand.result` 里给 `deltas: { seat: number }` 会更稳（现在前端的算法已经过测试，能用）。

---

## 3. 现有接口里需要修的两个小问题

### 3.1 断线删座会让牌局与座位表失步（中危）

```js
// apps/game-server/src/state/disconnectManager.js:46
t2.seats.delete(seat);        // ← 没有区分是否在局中
t2.userToSeat.delete(userId);
```

如果此人正在一手牌里，`handState.seats` 仍有他、他仍可能赢池，但 `t.seats` 已无此座 → `cleanupAfterHand` 回写 `t.seats.get(hs.seat)` 落空，**赢来的筹码会消失（不守恒）**。

建议：
```js
const inHand = t2.handState && !t2.handState.settled;
const hs = t2.handState?.seats.find((x) => x.seat === seat);
if (hs) { hs.folded = true; hs.sittingOut = true; }   // 局中标记弃牌/离座，等结算后再删
if (!inHand) { t2.seats.delete(seat); t2.userToSeat.delete(userId); }
```

### 3.2 超时回调里 `handState` 为 null 会静默哑掉（中危）

```js
// actionTimer.js:57
if (!t.handState || t.handState.handId !== handId) return;   // handState 为 null 时直接返回
```

此时既不会为新的一手重新排程，也不会有任何提示。建议改成：

```js
if (!t.handState) { maybeStartHand(t) && broadcastActionRequest(nsp, t); return; }
```

---

## 4. 前端当前的降级行为（接口没上时的表现）

| 缺失的接口 | 前端表现 |
|---|---|
| `GET /tables` | 列表区显示黄色提示"后端还没有 /tables 接口"，并展示**本机创建/加入过的牌局**（存在 `localStorage`，12 小时内有效）；仍可手动输入房号加入 |
| `POST /tables` | 前端本地生成房号并记配置，照常 `table:join` 开局；盲注走后端默认 10/20，日志里提示一次"先按本机牌局开局" |
| `table:leave` / `table:request_state` | 不使用 |
| 离线练习 | 完全不依赖后端：`net/mock-socket.js` 内置一个本地对手引擎（同样的协议与规则），用于演示与联调 UI |

接口一旦上线，前端**不需要改代码**，会自动从"降级提示 + 本机记录"切换到服务端列表。

---

## 5. 一个最小的验收清单

1. `GET /tables` 返回 1 个进行中的桌子 → 手机上打开前端，列表出现该桌子且标"进行中"；
2. 点"进入等待"→ 等待室显示阶段/底池/公共牌，并提示本手结束后可入座；
3. 这手结束（`hand` 变 null）→ 等待室"坐下"按钮变亮，入座后"准备"可点；
4. 两人准备 → 收到 `hand:start` 与 `game:action_request`，手机上出现 弃牌/过牌/跟注/下注 按钮；
5. 自定义金额输入 999999 → 被前端拦下并提示"最多只能下到 X"；输入合法值 → 服务端接受；
6. 结算 → 弹出"谁赢了 / 各自 ±筹码"的浮层，牌桌座位上方显示 `+`/`−` 变化。
