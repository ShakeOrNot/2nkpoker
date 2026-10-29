# ♠️ 2nkpoker

基于 Node.js + 原生 ESM 的德州扑克 Web 应用。前后端分离、零构建纯原生前端，核心是一个可脱离网络单测的纯函数扑克引擎。

## ✨ 核心特性

- **完整规则引擎**：2~6 人桌，翻牌前/翻牌/转牌/河牌全流程，主池 + 多层边池结算，短 all-in 规则。
- **实时对战**：Socket.IO 毫秒级同步；服务端权威（客户端只发意图），回合、金额、版本号全部在服务端校验。
- **连续对局**：一手结束自动开下一手；超时自动过牌/弃牌；断线 30 秒内可恢复原座位，超时自动离座。
- **移动端优先**：原生 ESM + 零构建，竖屏/横屏两套牌桌布局。
- **一条命令启动**：`node start.mjs`（或双击 `启动.cmd`）同时拉起前后端。

> 牌局状态目前在**内存**里，重启即清空；Redis 持久化还没实现（见 [协议文档的已知限制](docs/protocol.md#9-已知限制尚未实现别照着写前端)）。

## 🛠️ 技术栈

| 模块 | 技术选型 |
| :--- | :--- |
| **前端** | 原生 HTML / CSS / JS (ES Modules) |
| **后端** | Node.js, Fastify, Socket.IO |
| **引擎** | 纯函数实现（高可测试性） |
| **工具链** | pnpm Workspace, Vitest |

## 📂 项目结构

```text
2nkpoker/
├── apps/
│   ├── game-server/       # 后端：Fastify + Socket.IO + 牌局状态机
│   └── web/               # 前端：静态站点 + 开发代理（零构建）
├── packages/
│   ├── poker-engine/      # 核心：纯函数扑克引擎（发牌、比牌、边池、状态机）
│   └── shared/            # 共享：牌面常量、错误码、格式化
├── docs/protocol.md       # 协议与接口的唯一出处（HTTP / WS / 数据模型 / 错误码）
├── scripts/               # 冒烟脚本（部分需要后端在跑）
├── start.mjs              # 唯一启动入口（后端 + 前端）
├── 启动.cmd               # Windows 双击启动（转调 start.mjs）
├── .env.example           # 环境变量模板（全项目只此一份）
└── README.md
```

## 🚀 快速开始

### 1. 环境要求

- **Node.js** ≥ 22.5（推荐 24 LTS）：用户库用内置 `node:sqlite`，后端用 `process.loadEnvFile` 读 `.env`
- **pnpm** ≥ 9

### 2. 安装与配置

```bash
pnpm install
cp .env.example .env      # Windows: copy .env.example .env
```

`.env` 在**仓库根目录**，前后端、脚本、启动器都读这一份（改完重启生效）：

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `PORT` | 3001 | 后端端口 |
| `WEB_PORT` | 8080 | 前端端口 |
| `JWT_SECRET` | `dev_secret_change_me` | 生产必须换成强随机值 |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `2nkpoker` / `2nkpoker-web` | JWT 校验用 |
| `ACTION_TIMEOUT_MS` | 30000 | 轮到某人行动的超时，超时自动过牌/弃牌 |
| `RECONNECT_GRACE_MS` | 30000 | 掉线后保留座位的宽限期 |
| `SETTLE_HOLD_MS` | 2500 | 一手结束后停多久再开下一手（放结算动画） |
| `AUTH_DB_PATH` | `var/2nkpoker.db` | SQLite 用户库位置（默认仓库根 `var/`，已 gitignore） |
| `ACCESS_TTL_MS` | 900000 | access token 有效期（15 分钟） |
| `REFRESH_TTL_MS` | 604800000 | 刷新令牌有效期（7 天） |
| `ALLOW_DEV_TOKEN` | 1 | 是否挂载开发用的 `POST /dev/token`（生产始终关闭） |
| `AUTH_MAX_ATTEMPTS` / `AUTH_LOCK_MS` | 5 / 300000 | 同账号连续失败几次锁多久 |
| `AUTH_WINDOW_MS` / `AUTH_IP_MAX_ATTEMPTS` | 300000 / 20 | 同 IP 限流窗口与上限 |

### 3. 启动

```bash
node start.mjs                # 后端 3001 + 前端 8080
node start.mjs --port 9000    # 换前端端口
node start.mjs --game-port 4001
node start.mjs --watch        # 后端改代码自动重启
```

然后打开 `http://127.0.0.1:8080`。

- **第一次来**：登录页切到「注册」，填昵称 + 口令（昵称就是登录名，2~20 字符）
- **一个人试玩**：登录页直接点「离线练习（不需要后端）」，或注册后进大厅创建牌局
- **两个人试玩**：开一个**普通窗口** + 一个**无痕窗口**，各注册/登录一个账号。普通窗口的多个标签共用同一登录态，坐不成两个玩家
- **手机试玩**：同一 Wi-Fi，用启动时打印的「同一 Wi-Fi」地址

> 前端是原生 ES 模块，**必须通过 http 打开**（`file://` 会被浏览器拒绝）。`start.mjs` 就是干这个的。
> 用户库是 SQLite 单文件（`var/2nkpoker.db`）；删掉它就等于清空所有账号。

### 4. 账号与口令

- 口令用 scrypt 哈希存储，登录失败有锁定（同账号 5 次 / 5 分钟）
- **改口令**：大厅右上角「改口令」（改完其它设备立即失效，当前页面不受影响）
- **登录过期**：顶部出现黄色横幅，牌桌/房间都还在，点「重新登录」才回登录页
- **管理员重置**：先提权，再调接口或 CLI

```bash
# 提权（运维脚本）
node apps/game-server/scripts/reset-password.mjs --make-admin <昵称>
# 管理员令牌调接口
curl -X POST http://127.0.0.1:3001/auth/admin/reset-password \
  -H "Authorization: Bearer <admin-access-token>" -H "Content-Type: application/json" \
  -d '{"nickname":"忘了口令的人","newPassword":"new-poker-2026"}'
# 直接重置 / 禁用 / 查看
node apps/game-server/scripts/reset-password.mjs <昵称> <新口令>
node apps/game-server/scripts/reset-password.mjs --disable <昵称>
node apps/game-server/scripts/reset-password.mjs --list
```

**管理员面板**（`role=admin` 的账号在大厅右上角能看到「管理」）：

- 账号：按昵称搜索、翻页；看角色 / 是否禁用 / 令牌版本
- 操作：提为管理员 / 降为玩家、禁用 / 启用、重置口令（都要二次确认，且不能改自己）；重置口令支持**随机生成**，结果只显示一次、可复制
- 牌桌：列出所有牌桌和座位，可**解散牌局**（通知房间里所有人回大厅）或**踢出玩家**（手牌进行中不允许，避免卡局）
- 审计日志：最近 50 条登录、改密、管理员操作，带时间和 IP

### 5. 分进程调试（可选）

需要看两边日志时，开两个终端：

```bash
pnpm -F game-server dev                                   # 后端，带 --watch
node apps/web/dev-server.mjs --port 8080 --target http://127.0.0.1:3001   # 前端
```

## 🧪 测试

```bash
# 引擎（含状态机）+ 后端（vitest）
pnpm -r test

# 前端：零依赖，不需要装 vitest
node apps/web/test/run-tests.mjs
```

需要后端在跑的冒烟脚本：

```bash
node scripts/auth-smoke.js          # 注册 → 登录 → 刷新 → 改密 → 登出（真 HTTP）
node scripts/admin-smoke.js         # 管理员：列表 / 搜索 / 禁用 / 提权 / 审计（真 HTTP）
node scripts/play-smoke.js          # 两人真实打完一手
node scripts/table-smoke.js         # 入座/站起/快照同步
node scripts/seat-smoke.js          # 换座 + 手牌中离桌（本手结束后生效）
node scripts/sparse-seat-smoke.js   # 座位号不连续（0 和 3）也能开局
node scripts/queue-smoke.js         # 手牌中排队 → 观战 → 自动入座 → 参局
node scripts/timeout-smoke.js       # 超时自动过牌/弃牌
node scripts/reconnect-smoke.js     # 断线重连
```

调试小贴士：

- 前端零构建，改完直接刷新浏览器。
- 右上角小圆点＝连接状态；顶部红条＝任何未捕获错误（不会静默失败）。
- `window.__poker.store` 可以在控制台查看/改状态。
- 地址参数：`?api=http://host:3001` 指定后端，`?table=房号` 直接进牌局。

## 📦 生产部署

**安全警告**：必须换掉 `JWT_SECRET`，并用 Nginx 配 HTTPS。

**前端**：`apps/web/public` 是纯静态文件，整目录上传到 Nginx/CDN/对象存储即可。

**后端**：没有构建步骤，直接用 Node 跑源码：

```bash
NODE_ENV=production node apps/game-server/src/server.js   # 记得配好 .env 或真实环境变量
```

建议用 PM2 / systemd / Docker 做进程守护。注意：

- `NODE_ENV=production` 时 `POST /dev/token` 不会挂载，JWT 必须由外部 auth 服务签发
- 牌局状态在内存里，**重启会清空所有牌局和筹码**；多实例部署前必须先做持久化/粘性会话
- 反向代理后面要设 `TRUST_PROXY=1`（否则登录限流按代理 IP 算、审计 IP 全一样）
- 用户库 `var/2nkpoker.db` 要放持久卷，并每天备份：`node scripts/backup-db.mjs`
- 完整清单见 [云服务器部署清单](docs/deploy.md)

## 📚 文档

- [协议与接口约定](docs/protocol.md)：HTTP、WebSocket、数据模型、错误码、引擎工具清单、已知限制
- [云服务器部署清单](docs/deploy.md)：上公网前逐项打勾的检查表（密钥、HTTPS、反代、备份、管理员入口）
- [前端说明](apps/web/README.md)：目录结构、调试、离线/远端两种传输

## 👥 团队分工

| 成员 | 角色 | 负责模块 |
| :---: | :--- | :--- |
| **A** | 后端架构 | 用户系统、数据库设计、生产部署与运维 |
| **B** | 游戏核心 | 游戏引擎、实时网关、牌局状态机 |
| **C** | 前端开发 | 前端架构、大厅列表、用户注册与登录界面 |
| **D** | 前端/运维 | 牌桌 UI 交互、动画效果、CI/CD 脚本 |
| **E** | 视觉设计 | 品牌 Logo、牌桌视觉、卡牌/筹码图标、动效规范 |

---
*Private Project. All rights reserved.*
