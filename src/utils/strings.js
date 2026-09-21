// 字符串小工具（放独立模块，避免 config.js 与 judge/providers.js 互相 import）

// 密钥占位符判断（.env 里的示例值不算已配置）
export function isPlaceholder(value) {
  if (!value) return true;
  const v = String(value).trim().toLowerCase();
  return v.startsWith('your-') || v.startsWith('your_');
}

// 去掉 UTF-8 BOM：Windows 记事本保存的 JSON 会带 BOM，直接 JSON.parse 会报错
export function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '');
}
