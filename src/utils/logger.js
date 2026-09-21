// 简单日志工具
const ts = () => new Date().toLocaleString('zh-CN', { hour12: false });
export const log = (...args) => console.log(`[${ts()}]`, ...args);
export const warn = (...args) => console.warn(`[${ts()}] [WARN]`, ...args);
export const error = (...args) => console.error(`[${ts()}] [ERROR]`, ...args);
