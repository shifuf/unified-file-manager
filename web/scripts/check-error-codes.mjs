import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const javaSource = await readFile(
  join(repoRoot, 'server/core/src/main/java/com/ufm/common/error/ErrorCode.java'),
  'utf8',
)
const tsSource = await readFile(join(repoRoot, 'web/src/api/error-codes.ts'), 'utf8')

const javaCodes = new Set(
  [...javaSource.matchAll(/^\s{4}([A-Z][A-Z0-9_]+)\(/gm)].map((match) => match[1]),
)
const tsCodes = new Set(
  [...tsSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]),
)
const frontendOnly = new Set(['NETWORK_ERROR', 'UNKNOWN_ERROR'])

const failures = []
for (const code of javaCodes) {
  if (!tsCodes.has(code)) failures.push(`frontend is missing backend error code ${code}`)
}
for (const code of tsCodes) {
  if (!javaCodes.has(code) && !frontendOnly.has(code)) {
    failures.push(`frontend error code ${code} has no backend counterpart`)
  }
}

if (failures.length) {
  console.error('Error code contract check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`Error code contract check passed: ${javaCodes.size} backend codes mirrored by frontend.`)
