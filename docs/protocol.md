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

