\# Auth 契约



\## JWT



\- 算法：HS256

\- 签发方：A（auth-service）

\- 校验方：B（game-server）

\- 传输：Socket.IO `handshake.auth.token`

\- 有效期：15 分钟



\## Payload



```json

{

&#x20; "sub": "user\_123",

&#x20; "nickname": "Tom",

&#x20; "role": "user"

}

```



\## 环境变量



\- `JWT\_SECRET`：由 A 提供，写入 `.env`，不进 Git

\- `JWT\_ISSUER`：`2nkpoker`

\- `JWT\_AUDIENCE`：`2nkpoker-web`

