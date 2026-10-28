/**
 * 前端静态服务器需要"原样转发给后端"的路径前缀。
 *
 * 单独抽出来是为了能被测试覆盖：漏掉某个前缀的后果很隐蔽
 * （例如 /auth/* 没转发时，登录/注册会命中静态服务器变成 404，
 * 页面只会提示"连不上服务器"，看起来像后端没起）。
 */
export const PROXY_PATHS = [
  '/api/', // 带前缀的 API（转发时去掉 /api）
  '/socket.io', // Socket.IO：HTTP 轮询 + WebSocket 升级
  '/health',
  '/ready',
  '/dev/', // POST /dev/token
  '/tables',
  '/auth', // 账密系统：登录/注册/刷新/登出/改密
];

/**
 * @param {string} pathname
 * @returns {boolean}
 */
export function shouldProxy(pathname) {
  const clean = String(pathname ?? '').split('?')[0];
  return PROXY_PATHS.some((prefix) => {
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    // 必须整段匹配，避免 /tables.html、/authored.html 这种静态文件被误转发
    return clean === base || clean.startsWith(`${base}/`);
  });
}
