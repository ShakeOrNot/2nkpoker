# 云服务器部署清单

> 目标：一台 Linux 小机器就能跑（1 核 1G 起）。牌局状态在内存里，**只适合单实例**。
> 下面按顺序打勾；每项都写清了"为什么"和"怎么验证"。

## 0. 准备

- [ ] Node **≥ 22.5**（`node:sqlite` 要求）；建议 24 LTS
- [ ] 仓库放 `/srv/2nkpoker`，用独立系统用户（如 `2nk`）运行，不要用 root
- [ ] 防火墙只放行 `22`（SSH）、`80`、`443`；**3001 / 8080 不对外开放**

## 1. 环境变量（`.env`，不进 Git）

```bash
PORT=3001                 # 只监听本机，给反代用；可改 127.0.0.1:3001
WEB_PORT=8080
NODE_ENV=production

# 必须换成强随机值：openssl rand -hex 32
JWT_SECRET=<64 位十六进制>
JWT_ISSUER=2nkpoker
JWT_AUDIENCE=2nkpoker-web

AUTH_DB_PATH=/srv/2nkpoker/var/2nkpoker.db   # 放持久卷，别放容器临时层
ACCESS_TTL_MS=900000
REFRESH_TTL_MS=604800000
ALLOW_DEV_TOKEN=0          # 生产必须关
TRUST_PROXY=1              # 反代后面必须开，否则限流/审计拿到的是反代 IP
```

- [ ] `NODE_ENV=production`（关闭 `/dev/token`）
- [ ] `TRUST_PROXY=1`，并在反代里设置 `X-Forwarded-For`
- [ ] 验证：`node -e "import('./apps/game-server/src/env.js').then(m=>console.log(m.env.TRUST_PROXY))"` 输出 `true`

## 2. 反向代理 + HTTPS

Nginx 示例（Caddy 更简单，自动证书）：

```nginx
server {
  listen 443 ssl http2;
  server_name poker.example.com;
  # ssl_certificate ... 由 certbot 管理

  location / {
    proxy_pass http://127.0.0.1:8080;          # 静态站 + 前端 dev-server（生产可换成静态目录）
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Socket.IO 必须支持 WebSocket 升级
  location /socket.io/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
  }

  # 鉴权/管理接口直连后端（dev-server 也会代理，但生产建议显式写）
  location /auth/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
server { listen 80; server_name poker.example.com; return 301 https://$host$request_uri; }
```

- [ ] 强制 HTTPS（HSTS 可选；无 HTTPS 时 access token 会明文过网）
- [ ] 验证：浏览器地址栏锁标；`curl -I http://你的域名` 返回 301

## 3. 进程守护（systemd）

```ini
# /etc/systemd/system/2nkpoker.service
[Unit]
Description=2nkpoker
After=network.target

[Service]
Type=simple
User=2nk
WorkingDirectory=/srv/2nkpoker
ExecStart=/usr/bin/node apps/game-server/src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

前端静态站可以用 `node apps/web/dev-server.mjs` 常驻，或把 `apps/web/public` 交给 Nginx 直接读（更省资源，但 `/auth`、`/tables`、`/socket.io` 要自己代理）。

- [ ] `systemctl enable --now 2nkpoker`，`systemctl status` 是 active (running)
- [ ] 验证：`curl -s https://你的域名/health` → `{"ok":true,...}`

## 4. 数据与备份

- [ ] `var/` 在持久盘上；`var/2nkpoker.db` 不要被部署脚本覆盖
- [ ] 每天备份：`crontab -e` 加

```cron
0 4 * * * cd /srv/2nkpoker && /usr/bin/node scripts/backup-db.mjs /srv/backups/2nkpoker >> var/backup.log 2>&1
```

- [ ] 备份异地存一份（对象存储 / 另一台机器）；定期试恢复：拷回 `var/2nkpoker.db` 后重启
- [ ] 牌局状态重启即清空（内存），这是设计如此；账号/口令/审计在 SQLite 里不会丢

## 5. 管理员入口

推荐 **不把管理员入口暴露给全网**，三选一：

| 方式 | 做法 | 适合 |
| :--- | :--- | :--- |
| SSH 隧道（推荐） | `ssh -L 8080:127.0.0.1:8080 2nk@服务器`，本地开 `http://127.0.0.1:8080` 用管理员号登录 | 个人/小团队 |
| 反代 IP 白名单 | `/admin` 与 `/auth/admin/` 只允许你的固定 IP | 有固定出口 IP |
| 应用内面板 + 短会话 | 就是本项目的「管理」面板，仅 `role=admin` 可见；管理员 access 15 分钟 | 已经上了 HTTPS |

- [ ] 第一个管理员用 CLI 提权：`node apps/game-server/scripts/reset-password.mjs --make-admin <昵称>`
- [ ] 面板里高危操作（禁用/降权/重置口令）有二次确认，并写审计日志
- [ ] 验证：普通号在大厅看不到「管理」按钮；直接访问 `/auth/admin/users` 返回 403

## 6. 运维与回滚

- [ ] 日志：`journalctl -u 2nkpoker -f`；Fastify 请求日志、`audit_log` 表
- [ ] 更新：`git pull && systemctl restart 2nkpoker`（停机会清掉进行中的牌局）
- [ ] 回滚：`git checkout <上一个可用 commit> && systemctl restart`
- [ ] 已知单点：SQLite 单文件（不能多实例同时写）、牌局状态在内存、限流是内存实现（重启清零）

## 7. 上线前最后检查

- [ ] `.env` 不在 Git 里（`git check-ignore .env` 有输出）
- [ ] `JWT_SECRET` 不是 `dev_secret_change_me`
- [ ] `NODE_ENV=production`、`ALLOW_DEV_TOKEN=0`
- [ ] 账号库里没有弱口令测试号；`--list` 检查 role
- [ ] 备份 cron 真的跑过一次（`ls /srv/backups/2nkpoker`）
- [ ] 用手机 4G 访问一遍，确认 WebSocket 能连（反代没挡 upgrade）
