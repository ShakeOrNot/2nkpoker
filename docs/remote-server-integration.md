# 接入远端服务器 http://43.135.53.83:5173 / :3000

> 结论先说：**前端已经能连，且不需要后端配合。**
> 那台服务器的后端不是我们仓库里的 `game-server`（它是另一套协议），所以前端加了一层
> **协议适配**（[`apps/web/public/js/net/remote-protocol.js`](../../apps/web/public/js/net/remote-protocol.js)），
> 把他们的协议双向翻译成我们前端认识的 `table:*` / `game:*`，`store.js` 与所有视图一行未改。

---

## 一、那台服务器上有什么

| 地址 | 实际内容 | 说明 |
|---|---|---|
| `http://43.135.53.83:5173` | 一个 **Vite 构建的前端**（`<div id="app">`，标题 `frontend`） | 任何路径都返回同一个 HTML，**没有** `/health`、`/dev/token`、`/tables` |
| `http://43.135.53.83:3000` | 它真正的**后端**：纯 Socket.IO 服务，**无命名空间、无鉴权** | CORS 是 `Access-Control-Allow-Origin: *`，所以我们的页面可以直连 |

`5173` 那个前端里写死了 `http://43.135.53.83:3000`。

---

## 二、实测出来的远端协议（已逐条验证）

### 客户端 → 服务端

| 事件 | 载荷 | 说明 |
|---|---|---|
| `joinRoom` | `{ roomId, playerName }` | 加入即入座；**没有 token / 鉴权** |
| `playerReady` | `{ roomId }` | 相当于"切换准备"（没有取消准备的接口） |
| `playerAction` | `{ roomId, action, amount }` | `action` ∈ `check` / `call` / `fold` / `raise` |

### 服务端 → 客户端

| 事件 | 载荷（真实抓包） |
|---|---|
| `playerList` | `[ { id, name, chips, seat, status, currentBet, hasActed, ready } ]` |
| `myHand` | `[ '2♠', 'J♥' ]` —— 只有本人收到 |
| `joinSuccess` | `{ seat, name }` |
| `joinFailed` | `'这个名字已经被占用了，换一个吧！'` |
| `gameState` | `{ players, pot, currentTurn, currentBet, phase, communityCards, started, dealerSeat, smallBlind, bigBlind, lastRaiseAmount }` |
| `showdownResult` | `{ winners: [ { name, seat, amount } ], share }` |
| `errorMsg` | `'错误文案'` |

**关键差异（适配层已处理）**

| 差异点 | 他们 | 我们 | 适配做法 |
|---|---|---|---|
| 牌面写法 | `'K♥'`（点数+符号） | `'Kh'`（点数+字母） | `logic.js` 的 `cardFromSymbol` / `cardToSymbol` 双向转换 |
| 座位号 | 从 **1** 开始 | 从 **0** 开始 | 转换时 ±1 |
| 动作集合 | 只有 `check/call/fold/raise` | 还有 `bet` / `all_in` | `bet`→`raise`；`all_in`→`raise` 且 `amount=全部筹码` |
| `raise.amount` | **本街下注到的总额**（实测：注 20 → raise 40 后该玩家 `currentBet=40`） | 同样语义 | 直接透传，语义天然一致 |
| 阶段 | `preflop/flop/turn/river/showdown` | `PREFLOP/…/SETTLED` | 映射表 |
| 身份 | 昵称（无鉴权） | JWT | 适配模式下**跳过取 token**，直接用昵称 |
| 结算 | `showdownResult.winners[].amount` 是**总池** | 期望每座位净变化 | 用"筹码差"推算 `totalCommitted`，得出 ±净变化 |
| 摊牌后 | `started=false`、`pot=0`、手牌快照清空 | 保留 `settled:true` 的快照 | 适配层保留"刚打完那一手"用于展示结算 |
| 房间配置 | 固定 1000 筹码、10/20 盲注（无视我们的带入/盲注设置） | 可配 | 界面上以远端返回的盲注为准 |

---

## 三、怎么用

### 方式 A：分享链接（最省事）

启动本地静态服务器后，把地址带上参数即可：

```bash
node apps/web/dev-server.mjs --port 8199 --no-proxy
```

```
http://localhost:8199/?api=http://43.135.53.83:3000&table=房间号&proto=remote
```

- `api=` 远端后端地址
- `table=` 房间号（**远端用它当房间标识，任何字符串都行**；`joinRoom` 时若房间不存在会自动创建）
- `proto=remote` 强制走协议适配（其实包含 `43.135.53.83` 的地址会自动识别，可省略）

### 方式 B：界面上填

登录页 →「服务器与高级设置」→ 后端地址填 `http://43.135.53.83:3000` → 保存 →
输入用户名 →「进入牌局大厅」→ 加入/创建牌局。
（适配模式下**不会去取 token**，因为远端不需要登录；点「创建牌局」生成的房号就是远端房间号。）

> 注意：`dev-server.mjs` 的代理默认已经指向 `http://43.135.53.83:3000`。
> 如果你想连本仓库的 `game-server`，加 `--target http://127.0.0.1:3001`。

### 方式 C：手机

手机和电脑同一 Wi-Fi，用电脑局域网 IP 打开
`http://192.168.x.x:8199/?api=http://43.135.53.83:3000&table=abc123&proto=remote` 即可。

---

## 四、已验证到什么程度

在真实浏览器（无头 Edge）+ 真实远端服务器上跑通了完整一手：

```
ok  Node 对手已入座 seat=1
ok  浏览器端已入座 seat=1
ok  双方准备后自动开局  phase=table street=PREFLOP
ok  我的底牌已翻译成我们的格式  ["Ad","Jh"]        ← 远端 'A♦','J♥'
ok  底池与座位来自远端  pot=30
ok  我在浏览器里成功出手  次数=4 类型=raise,check,check,check
ok  打到结算并翻译出结果  [{"amount":80,"eligibleSeats":[1]}]
ok  桌面上出现过结算浮层  你赢了 40 底池 80 公共牌8♥6♠T♦9♦Q♦ 我（你）+40 对手−40
ok  结算里的公共牌也是我们的格式  ["8h","6s","Td","9d","Qd"]
浏览器未捕获异常：（无）
```

复现命令（需要本机有 Edge/Chrome）：

```bash
node apps/web/dev-server.mjs --port 8199 --no-proxy      # 终端 1
node apps/web/test/.dsh-tests/browser-remote-hand.mjs    # 终端 2：浏览器 + Node 对手打一手
```

---

## 五、已知限制（远端协议本身不支持）

1. **看不到对手的牌**：`showdownResult` 只给 `{ name, seat, amount }`，没有牌面。所以结算浮层里
   赢家显示"未亮牌"（自己的牌会显示）。如果远端以后在 `winners[]` 里加上 `cards`，适配层会自动用上。
2. **不能离座**：没有对应的远端事件，`table:stand` 会返回"这个服务器不支持离座"，界面会提示。
3. **不能改盲注/带入**：远端固定 1000 筹码与 10/20 盲注，创建牌局时的这些设置对远端无效。
4. **不能取消准备**：远端 `playerReady` 是切换语义，没有"取消"接口。
5. **必须有两个人**：远端一人不开始（与我们一致），验证时用 Node 对手脚本或第二个浏览器标签
   （注意：同一浏览器共享 `localStorage`，同机会被当成同一个账号，请用无痕窗口或另一个浏览器）。
6. **超时自动弃牌**：远端是否实现了行动倒计时未验证；我们的操作栏倒计时是按 30 秒本地显示的。
