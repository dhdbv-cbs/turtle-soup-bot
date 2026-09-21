// 密钥占位符判断（.env 里的示例值不算已配置）
//
// 单独一个模块，避免 config.js ↔ judge/providers.js 互相 import。
export function isPlaceholder(value) {
  if (!value) return true;
  const v = String(value).trim().toLowerCase();
  return v.startsWith('your-') || v.startsWith('your_');
}
