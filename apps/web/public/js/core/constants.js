/**
 * 全站共享常量：领域数值 + 协议名字（前后端事件的唯一出处）
 * 只放常量，不放逻辑，方便被任何模块 import。
 */

/** 座位号上限（后端 TableSitSchema: seat -1~9，桌子 maxSeats=6） */
export const MAX_SEATS = 6;

/** 盲注档位（与后端 tableManager 的 smallBlind/bigBlind 语义一致；当前后端写死 10/20） */
export const BLIND_LEVELS = [
  { label: '10 / 20', smallBlind: 10, bigBlind: 20 },
  { label: '25 / 50', smallBlind: 25, bigBlind: 50 },
  { label: '50 / 100', smallBlind: 50, bigBlind: 100 },
  { label: '100 / 200', smallBlind: 100, bigBlind: 200 },
];

export const DEFAULT_BLIND_INDEX = 0;

/** 带入筹码范围：后端 handler 实际限制为 100~100000 */
export const MIN_BUY_IN = 100;
export const MAX_BUY_IN = 100000;

/** 结算后重新准备前的最短展示时间（毫秒） */
export const RESULT_HOLD_MS = 4500;

/** 客户端 → 服务端 */
export const C2S = {
  TABLE_JOIN: 'table:join',
  TABLE_SIT: 'table:sit',
  TABLE_STAND: 'table:stand',
  TABLE_READY: 'table:ready',
  GAME_ACTION: 'game:action',
};

/** 服务端 → 客户端 */
export const S2C = {
  SNAPSHOT: 'table:snapshot',
  HAND_START: 'hand:start',
  ACTION_REQUEST: 'game:action_request',
  ACTION_APPLIED: 'game:action_applied',
  RESULT: 'game:result',
};

/**
 * 服务端错误码 → 中文提示。
 * 与 docs/protocol.md 的错误码表对齐（前后端唯一出处以文档为准）。
 */
export const ERROR_TEXT = {
  AUTH_FAILED: '登录已失效，请重新登录',
  AUTH_EXPIRED: '登录已过期，请重新登录',
  AUTH_INVALID_CREDENTIALS: '昵称或口令不对',
  AUTH_USER_EXISTS: '这个昵称已经被注册了',
  AUTH_WEAK_PASSWORD: '口令太弱：至少 8 位，不能纯数字，也不能和昵称相同',
  AUTH_INVALID_NICKNAME: '昵称需 2~20 个字符，只能用字母/数字/下划线/中划线/点/@/中文',
  AUTH_LOCKED: '失败次数过多，账号已临时锁定，稍后再试',
  AUTH_REFRESH_INVALID: '登录已失效，请重新登录',
  AUTH_CREDENTIALS_CHANGED: '口令已变更，请重新登录',
  AUTH_DISABLED: '账号已被禁用，请联系管理员',
  FORBIDDEN: '你没有权限做这个操作',
  USER_NOT_FOUND: '没有这个账号',
  USER_NOT_IN_TABLE: '该玩家不在这张桌上',
  CANNOT_MODIFY_SELF: '不能修改自己的账号（改自己请用「改口令」）',
  LAST_ADMIN: '至少要保留一个管理员',
  NEED_PASSWORD: '请输入口令',
  OFFLINE_NO_ACCOUNT: '离线练习不需要注册',
  TABLE_NOT_FOUND: '牌局不存在，可能已被解散',
  TABLE_FULL: '牌局已坐满，换个牌局试试',
  SEAT_TAKEN: '该座位已被占用',
  SEAT_INVALID: '座位号非法',
  NOT_SEATED: '你还没有入座',
  NOT_YOUR_TURN: '还没轮到你行动',
  INVALID_ACTION: '这个操作现在不允许',
  STATE_OUTDATED: '牌局状态已更新，请重试',
  INSUFFICIENT_CHIPS: '筹码不足',
  HAND_NOT_ACTIVE: '当前没有进行中的牌局',
  HAND_IN_PROGRESS: '牌局进行中，暂时不能入座或离座',
  ALREADY_SEATED: '你已经在这张牌局里了',
  INVALID_BUY_IN: `带入筹码必须在 ${MIN_BUY_IN}~${MAX_BUY_IN} 之间`,
  INVALID_PAYLOAD: '请求格式不对，请刷新页面重试',
  RATE_LIMITED: '操作太快了，稍等一下',
  INTERNAL_ERROR: '服务异常，请稍后重试',
  /** 前端本地码 */
  NETWORK: '连不上服务器，请检查网络或服务是否已启动',
  NOT_CONNECTED: '还没有连上服务器',
  NO_LEGAL_ACTION: '现在没有可执行的操作',
  ROOM_LIST_UNAVAILABLE: '牌局列表暂时取不到，先显示本机记录',
  BAD_AMOUNT: '下注金额超出可用筹码或不符合规则',
  NEED_USERNAME: '请输入用户名',
  NO_HAND: '本手牌还没开始',
  ALREADY_IN_OTHER_TABLE: '你已经在另一张桌子上了，请先退出那张桌子',
};
/**
 * @param {string|undefined|null} code
 * @param {string} [fallback]
 * @returns {string}
 */
export function errorText(code, fallback = '操作失败，请重试') {
  if (!code) return fallback;
  return ERROR_TEXT[code] ?? `${fallback}（${code}）`;
}
