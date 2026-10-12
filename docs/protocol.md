\# WebSocket 协议



命名空间：`/game`

握手：`socket.handshake.auth.token`（JWT）



\## 客户端 -> 服务端



| 事件 | 载荷 | 说明 |

|---|---|---|

| `table:join` | `{ tableId }` | 加入房间 |

| `table:leave` | `{ tableId }` | 离开房间 |

| `table:sit` | `{ tableId, seat, buyIn }` | 坐下 |

| `table:stand` | `{ tableId }` | 站起 |

| `table:ready` | `{ tableId, ready }` | 准备 |

| `table:request\_state` | `{ tableId, lastVersion? }` | 请求快照 |

| `game:action` | `{ tableId, handId, expectedVersion, action }` | 游戏动作 |



所有事件都带 ack 回调，返回 `{ ok, code?, message? }`。



\## 服务端 -> 客户端



| 事件 | 载荷 |

|---|---|

| `table:snapshot` | `TableSnapshot` |

| `hand:start` | `{ handId, buttonSeat, smallBlind, bigBlind }` |

| `hand:hole\_cards` | `{ handId, cards }`（只发本人） |

| `game:action\_request` | `{ seat, legalActions, deadline }` |

| `game:action\_applied` | `{ seat, action, pot }` |

| `game:street` | `{ street, board }` |

| `game:showdown` | `{ reveals }` |

| `game:result` | `{ winners }` |

| `error` | `{ code, message, context? }` |



\## 规则



\- 前端只发意图，服务端算结果

\- 手牌只发本人

\- 所有金额是整数

\- `version` 单调递增，过期直接拒绝



\## 动画时机（给 E）



| 事件 | 动画 |

|---|---|

| `hand:start` | 洗牌、发牌 |

| `hand:hole\_cards` | 手牌翻开 |

| `game:street` FLOP | 翻 3 张 |

| `game:street` TURN | 翻 1 张 |

| `game:street` RIVER | 翻 1 张 |

| `game:action\_applied` | 筹码飞向底池 |

| `game:showdown` | 亮牌 |

| `game:result` | 筹码飞向赢家 |

---

## Day 5 后端工具清单

这些函数在 `@2nkpoker/poker-engine` 和 `@2nkpoker/shared` 里，前端可直接 import。

### 位置（`poker-engine/positions.js`）

- `Position`：BTN / SB / BB / UTG / HJ / CO
- `positionsFor(n)` → 位置名数组，n ∈ [2, 6]
- `positionOf(seat, buttonSeat, n)`
- `seatPositions(buttonSeat, n)` → Map<seat, position>
- `preflopOrder(buttonSeat, n)` → 座位号数组，翻前行动顺序
- `postflopOrder(buttonSeat, n)` → 座位号数组，翻后行动顺序

### 底池（`poker-engine/pot.js`）

- `buildPots(contributions)` → `Pot[]`，每层独立，**不合并**
  - `contributions`: `[{ seat, amount, folded }]`
  - `Pot`: `{ amount, eligibleSeats: number[] }`
- `totalPot(pots)`
- `awardPots(pots, handStrengthBySeat)`
  - 每层独立找 eligibleSeats 中牌力最高者
  - 多人并列 → 平分；余数给**座位号最小**的赢家
  - 返回 `Map<seat, chips>`
  - `eligibleSeats` 为空的层被跳过（退还逻辑在 Day 6 状态机）

### 下注快捷（`poker-engine/betSizing.js`）

- `BetFraction`：`THIRD=1/3`、`HALF=0.5`、`TWO_THIRDS=2/3`、`FULL=1`、`ONE_POINT_TWO=1.2`
- `calcBetSize({ pot, fraction, currentBet, myBetThisStreet, chips, minRaise, bigBlind })`
  - 返回 `{ type: 'bet'|'raise', amount, capped, isAllIn, fraction }`
  - `amount` 是"本街下注到多少"，不是增量
  - 无人下注 → `raise_to = round(fraction * pot)`，下限 bigBlind
  - 有人下注 → `raise_to = round(currentBet + fraction * (pot + 2 * toCall))`，下限 currentBet + minRaise
  - 超过 `myBetThisStreet + chips` 时截断并 `capped: true`

### 行动合法性（`poker-engine/actions.js`）

- `legalActions(state, seat)` → 类型数组
- `validateAction(state, seat, action)` → `{ pay, isRaise, isAllIn }` 或抛 `ActionError`
- `ActionError`：`NOT_YOUR_TURN` / `INVALID_ACTION` / `INSUFFICIENT_CHIPS` / `SEAT_INVALID`

### 格式化（`shared/format.js`）

- `potPercent(amount, pot)` → `"50%"`、`"120%"`
- `formatChips(n)` → `"1.2k"`、`"1.5m"`
- `formatDuration(ms)` → `"30s"`、`"1m"`

### 前端注意

- `bet` / `raise` 的 `amount` 都是**目标金额**（total this street），不是增量
- `capped: true` 表示"点这个按钮会 all-in，因为筹码不够"
- `awardPots` 返回的 `Map` 只包含赢家，没赢的座位不出现
## 短 all-in 规则

- all-in 加注幅度 < `minRaise` 时，**不重置**其他玩家的 `hasActedThisStreet`（不能再加注）
- 但任何 `betThisStreet < currentBet` 的玩家仍必须行动一次（补差额或弃牌）
- 多次短 all-in 累积达到 `minRaise` 时，仍然算一次完整加注，会重置行动
## HandState 字段分工

| 字段 | 含义 | 何时重置 |
|---|---|---|
| `betThisStreet` | 本街已下注 | **换街时** 清零 |
| `totalCommitted` | 本手累计投入 | 从不重置，摊牌后用于 `buildPots` |
| `chips` | 剩余筹码 | 递减 |
| `hasActedThisStreet` | 本街是否已行动 | 换街或**合法加注**时重置 |