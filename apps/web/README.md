# 2nk 德州扑克 · 前端

原生 ESM，**零构建、零依赖**。改完刷新浏览器即可，不需要打包。

## 目录

```text
apps/web/
├── public/                 ← 静态站点（必须通过 http 打开，见下方说明）
│   ├── index.html
│   ├── css/app.css
│   ├── img/
│   └── js/
│       ├── app.js          视图路由 + 全局工具条 + 未捕获错误兜底
│       ├── store.js        状态层（把传输层事件收敛成一份可渲染状态）
│       ├── core/           常量 / 配置 / DOM 小工具 / 格式化 / 纯逻辑
│       ├── net/            HTTP 接口 / socket.io 封装 / 本机牌局记录 / 离线对手引擎 / 远端协议适配
│       └── views/          登录、大厅、等待室、牌桌、操作栏、牌面
├── dev-server.mjs          零依赖静态服务器（含 /api、/socket.io 反向代理）
└── test/                   零依赖测试（单元 + 模块冒烟 + 端到端）
```

## 怎么启动

```bash
node start.mjs            # 仓库根目录，一条命令起后端 + 前端
```

只想起前端（纯静态、配合已有后端）：

```bash
node apps/web/dev-server.mjs --port 8080 --target http://127.0.0.1:3001
```

> ⚠️ **别用 `file://` 直接双击 index.html**：浏览器会拒绝加载 ES 模块，页面会停在启动占位并提示原因。

## 前端怎么找后端

`core/config.js` 按优先级解析：

1. URL 参数：`?api=http://host:3001&ws=http://host:3001`
2. `localStorage` 里的设置（登录页「服务器」折叠项）
3. 同源：`dev-server.mjs` 已经代理 `/api`、`/socket.io`、`/tables`、`/dev`、`/health`
4. 兜底：`http://<当前主机名>:3001`

手机连电脑时用电脑的局域网地址 + 8080（同源代理，避免 CORS）。

## 三种传输

`store.js` 会根据配置选一个：

| 模式 | 触发 | 说明 |
| :--- | :--- | :--- |
| 真实 socket | 默认 | `net/socket.js`，连 Socket.IO `/game` 命名空间，JWT 走 `handshake.auth.token` |
| 离线练习 | 登录页「离线练习」 | `net/mock-socket.js`，本地对手引擎，不需要后端 |
| 远端协议适配 | `?proto=remote` 或目标不是本仓库后端 | `net/remote-protocol.js`，把对方协议翻译成本仓库的 `table:*` / `game:*` |

## 调试

- 连接状态：右上角小圆点（绿=已连接 / 黄=连接中 / 红=已断开）
- 顶部红色错误条：任何失败（含未捕获异常、未处理的 Promise）都会显示，**不会静默失败**
- 控制台：`window.__poker.store` 查看/改状态，`window.__poker.store.reportError('...')` 手动弹提示
- 地址参数：`?api=` 指定后端，`?table=` 指定房号（分享链接就是这个格式）

## 测试

```bash
node apps/web/test/run-tests.mjs                    # 单元测试（零依赖，自带 vitest 替身）
node apps/web/test/.dsh-tests/dom-smoke.mjs         # 模块 import + 各阶段渲染冒烟
node apps/web/test/.dsh-tests/e2e-smoke.mjs         # 装配 app.js，模拟点击走完整流程
```

真实浏览器联调（需要本机有 Edge/Chrome）：

```bash
node apps/web/test/.dsh-tests/browser-check.mjs http://127.0.0.1:8080/
```

协议（事件、快照字段、错误码）以 [docs/protocol.md](../../docs/protocol.md) 为准。
