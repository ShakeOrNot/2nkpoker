/**
 * 单测环境变量（必须在其它模块之前 import，env.js 会读这些）
 */
process.env.JWT_SECRET ??= 'test-secret-for-unit-tests';
process.env.JWT_ISSUER ??= '2nkpoker';
process.env.JWT_AUDIENCE ??= '2nkpoker-web';
process.env.ACCESS_TTL_MS ??= '900000';
process.env.REFRESH_TTL_MS ??= '604800000';
