/**
 * 字节数人类可读化。
 *
 * 说明：接口返回的仍是原始字节数，这里只负责展示层换算，
 * 不做四舍五入到「整数单位」的近似，避免把 1000 B 显示成 1 KB。
 */
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const

export function bytes(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未知'
  let size = value
  let unit = 0
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : size >= 100 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(digits)} ${UNITS[unit]}`
}
