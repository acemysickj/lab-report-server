// src/lib/http-error.js — 带 statusCode/code 的业务错误（供 setErrorHandler 统一整形）
export function httpError(statusCode, code, message) {
  const err = new Error(message ?? code);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}
