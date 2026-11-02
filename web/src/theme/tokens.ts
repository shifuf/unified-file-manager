/**
 * 设计令牌的 TS 镜像。
 *
 * 为什么要有这份文件：Naive UI 的 themeOverrides 只接受 JS 值，不读 CSS 变量。
 * 为保证「唯一色源」，这里的值必须与 src/styles/tokens.css 一一对应，
 * 改动时两处同步（CI 里的 check:tokens 脚本会做正则比对，见 scripts/check-tokens.mjs）。
 *
 * 除本文件外，业务组件里禁止出现十六进制色值。
 */

export const lightPalette = {
  bg: '#FAFAFA',
  bgSoft: '#F7F9FC',
  surface: '#FFFFFF',
  surface2: '#F1F5F9',

  border: '#E2E8F0',
  borderStrong: '#D3DEEB',
  divider: '#E2E8F0',

  textStrong: '#0F172A',
  text: '#1E293B',
  textMuted: '#64748B',
  placeholder: '#94A3B8',
  onAccent: '#FFFFFF',

  accent: '#0052FF',
  accent2: '#4D7CFF',
  accentHover: '#0047DE',
  accentPressed: '#0038B0',
  accentSoft: '#E9F0FF',
  accentInk: '#1F57CC',

  success: '#16A34A',
  warning: '#B88336',
  danger: '#DC2626',
  info: '#2563EB',

  tagSuccessBg: '#E8F5F0',
  tagSuccessBorder: '#BFE3D4',
  tagSuccessText: '#256C56',
  tagWarningBg: '#FFF4E8',
  tagWarningBorder: '#F2D9BB',
  tagWarningText: '#9A6425',
  tagDangerBg: '#FBEEEE',
  tagDangerBorder: '#F0C7C7',
  tagDangerText: '#A54646',
  tagInfoBg: '#EAF2FF',
  tagInfoBorder: '#C1D7FB',
  tagInfoText: '#2F66B3',

  inputBorder: '#D6E1EE',
  inputBorderHover: '#C1D2E8',
  btnSecondaryBorder: '#D4DFEF',
  btnSecondaryText: '#475569',
  dangerSoft: '#FEF2F2',
  tableHeadBg: '#F8FAFC',
  navHoverBg: '#F8FAFC',

  scrollbarTrack: '#EAF0F8',
  scrollbarThumb: '#B9CBE5',
  scrollbarThumbHover: '#A4BAD9',
} as const

export const darkPalette = {
  bg: '#0C0E14',
  bgSoft: '#12141E',
  surface: '#141620',
  surface2: '#1A1D2B',

  border: '#2A2E3E',
  borderStrong: '#3A3F52',
  divider: '#252838',

  textStrong: '#E2E8F0',
  text: '#CBD5E1',
  textMuted: '#94A3B8',
  placeholder: '#64748B',
  onAccent: '#FFFFFF',

  accent: '#4D7CFF',
  accent2: '#6B93FF',
  accentHover: '#3366FF',
  accentPressed: '#3366FF',
  accentSoft: '#1A2544',
  accentInk: '#6B93FF',

  success: '#4ADE80',
  warning: '#FBBF24',
  danger: '#F87171',
  info: '#60A5FA',

  tagSuccessBg: 'rgba(74, 222, 128, .12)',
  tagSuccessBorder: 'rgba(74, 222, 128, .28)',
  tagSuccessText: '#4ADE80',
  tagWarningBg: 'rgba(251, 191, 36, .12)',
  tagWarningBorder: 'rgba(251, 191, 36, .28)',
  tagWarningText: '#FBBF24',
  tagDangerBg: 'rgba(248, 113, 113, .12)',
  tagDangerBorder: 'rgba(248, 113, 113, .28)',
  tagDangerText: '#F87171',
  tagInfoBg: 'rgba(96, 165, 250, .12)',
  tagInfoBorder: 'rgba(96, 165, 250, .28)',
  tagInfoText: '#60A5FA',

  inputBorder: '#2A2E3E',
  inputBorderHover: '#3A3F52',
  btnSecondaryBorder: '#3A3F52',
  btnSecondaryText: '#CBD5E1',
  dangerSoft: 'rgba(248, 113, 113, .10)',
  tableHeadBg: '#1A1D2B',
  navHoverBg: '#1A1D2B',

  scrollbarTrack: '#2A2E3E',
  scrollbarThumb: '#3A3F52',
  scrollbarThumbHover: '#3A3F52',
} as const

export const radius = {
  xs: '8px',
  sm: '10px',
  md: '12px',
  lg: '16px',
  card: '16px',
  xl: '20px',
  sidebar: '24px',
  pill: '999px',
} as const

export const font = {
  ui: 'Inter, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  mono: '"JetBrains Mono", Consolas, "Courier New", monospace',
  display: 'Calistoga, Georgia, "Times New Roman", serif',
} as const
