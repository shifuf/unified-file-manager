import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('..', import.meta.url))
const srcRoot = join(webRoot, 'src')
const failures = []

const tokenCss = await readFile(join(srcRoot, 'styles/tokens.css'), 'utf8')
const tokenTs = await readFile(join(srcRoot, 'theme/tokens.ts'), 'utf8')

function cssBlock(source, selector) {
  const start = source.indexOf(selector)
  if (start < 0) throw new Error(`Missing CSS block: ${selector}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`Unclosed CSS block: ${selector}`)
}

function declarations(block) {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
  )
}

function objectValues(source, exportName) {
  const start = source.indexOf(`export const ${exportName}`)
  if (start < 0) throw new Error(`Missing TS export: ${exportName}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return Object.fromEntries(
          [...source.slice(open + 1, i).matchAll(/(\w+)\s*:\s*'([^']+)'/g)]
            .map((match) => [match[1], match[2]]),
        )
      }
    }
  }
  throw new Error(`Unclosed TS object: ${exportName}`)
}

const tokenMap = {
  bg: 'bg',
  'bg-soft': 'bgSoft',
  surface: 'surface',
  'surface-2': 'surface2',
  border: 'border',
  'border-strong': 'borderStrong',
  divider: 'divider',
  'text-strong': 'textStrong',
  text: 'text',
  'text-muted': 'textMuted',
  placeholder: 'placeholder',
  'on-accent': 'onAccent',
  accent: 'accent',
  'accent-2': 'accent2',
  'accent-hover': 'accentHover',
  'accent-pressed': 'accentPressed',
  'accent-soft': 'accentSoft',
  'accent-ink': 'accentInk',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  'tag-success-bg': 'tagSuccessBg',
  'tag-success-border': 'tagSuccessBorder',
  'tag-success-text': 'tagSuccessText',
  'tag-warning-bg': 'tagWarningBg',
  'tag-warning-border': 'tagWarningBorder',
  'tag-warning-text': 'tagWarningText',
  'tag-danger-bg': 'tagDangerBg',
  'tag-danger-border': 'tagDangerBorder',
  'tag-danger-text': 'tagDangerText',
  'tag-info-bg': 'tagInfoBg',
  'tag-info-border': 'tagInfoBorder',
  'tag-info-text': 'tagInfoText',
  'input-border': 'inputBorder',
  'input-border-hover': 'inputBorderHover',
  'btn-secondary-border': 'btnSecondaryBorder',
  'btn-secondary-text': 'btnSecondaryText',
  'danger-soft': 'dangerSoft',
  'table-head-bg': 'tableHeadBg',
  'nav-hover-bg': 'navHoverBg',
  'scrollbar-track': 'scrollbarTrack',
  'scrollbar-thumb': 'scrollbarThumb',
  'scrollbar-thumb-hover': 'scrollbarThumbHover',
}

const normalize = (value) => value.replace(/\s+/g, '').toLowerCase()
const themes = [
  { name: 'light', selector: ':root', tsName: 'lightPalette' },
  { name: 'dark', selector: 'html.dark', tsName: 'darkPalette' },
]

for (const theme of themes) {
  const cssValues = declarations(cssBlock(tokenCss, theme.selector))
  const tsValues = objectValues(tokenTs, theme.tsName)
  for (const [cssKey, tsKey] of Object.entries(tokenMap)) {
    if (!cssValues[cssKey]) {
      failures.push(`${theme.name}: missing CSS token --${cssKey}`)
      continue
    }
    if (!tsValues[tsKey]) {
      failures.push(`${theme.name}: missing TS token ${theme.tsName}.${tsKey}`)
      continue
    }
    if (normalize(cssValues[cssKey]) !== normalize(tsValues[tsKey])) {
      failures.push(
        `${theme.name}: --${cssKey} (${cssValues[cssKey]}) != ${theme.tsName}.${tsKey} (${tsValues[tsKey]})`,
      )
    }
  }
}

if (!/color-scheme:\s*light/.test(cssBlock(tokenCss, ':root'))) {
  failures.push('light: :root must set color-scheme: light')
}
if (!/color-scheme:\s*dark/.test(cssBlock(tokenCss, 'html.dark'))) {
  failures.push('dark: html.dark must set color-scheme: dark')
}

const violetLines = tokenCss
  .split(/\r?\n/)
  .map((line, index) => ({ line, index: index + 1 }))
  .filter(({ line }) => line.includes('139, 92, 246'))
for (const entry of violetLines) {
  if (!entry.line.includes('radial-gradient') || !/\.0[1-5]\)/.test(entry.line)) {
    failures.push(`line ${entry.index}: violet is only allowed in ambient glow at <= .05 opacity`)
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

const sourceFiles = await walk(srcRoot)
for (const file of sourceFiles) {
  const ext = extname(file)
  if (!['.css', '.vue', '.ts', '.html'].includes(ext)) continue
  const normalizedFile = file.replaceAll('\\', '/')
  if (normalizedFile.endsWith('styles/tokens.css') || normalizedFile.includes('/theme/')) continue
  const source = await readFile(file, 'utf8')
  const local = relative(webRoot, file)
  if (/(^|[^&\w])#[0-9a-f]{3,8}\b/i.test(source) || /\brgba?\(/i.test(source)) {
    failures.push(`${local}: component color must reference a design token variable`)
  }
  if (/[\p{Extended_Pictographic}\uFE0F]/u.test(source)) {
    failures.push(`${local}: emoji is forbidden; use the SVG AppIcon component`)
  }
}

if (failures.length) {
  console.error('Design token check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Design token check passed: CSS/TS palettes match, components use variables, SVG-only icons.')
