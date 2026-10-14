## 快速上手

### 环境要求

- Node.js ≥ 20.6（推荐 20 或 22 LTS）
- pnpm ≥ 9

安装 pnpm：

```bash
npm install -g pnpm
```

安装依赖

```bash
git clone https://github.com/<your-org>/2nkpoker.git
cd 2nkpoker
pnpm install
```

启动后端

```bash
cd apps/game-server
cp .env.example .env
pnpm dev
```

期望输出：game-server listening on 3001。

启动前端

新开一个终端：

```bash
pnpm -F @2nkpoker/web dev
```

浏览器打开 http://localhost:3000。

拿一个测试 token

```powershell
# PowerShell
$body = @{ nickname = "Tom" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3001/dev/token `
  -ContentType "application/json" -Body $body
```

玩单文件 demo

```bash
npx http-server apps/web/public -p 5173
```

浏览器打开 http://127.0.0.1:5173/demo.html。开两个标签，昵称不同，点坐下和准备。

测试

```bash
pnpm -r test
```

期望：packages/shared、packages/poker-engine 全绿。

文档

· docs/protocol.md — WebSocket 协议
· docs/frontend-contract.md — 前端契约
· docs/error-codes.md — 错误码
· docs/auth-contract.md — JWT 约定

团队分工

角色 负责
A 后端架构、账号系统、数据库、部署
B 游戏引擎、实时网关、牌局状态机
C 前端架构、大厅、用户系统
D 牌桌 UI、动画、运维
E 美术、UI/UX

License

Private.

```
