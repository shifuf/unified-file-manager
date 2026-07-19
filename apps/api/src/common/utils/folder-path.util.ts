/** Normalize folder path: trim, strip leading/trailing slashes, collapse // */
export function normalizeFolderPath(input?: string | null): string | null {
  if (input == null) {
    return null;
  }
  const trimmed = String(input).trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '/') {
    return null;
  }
  const cleaned = trimmed
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
  return cleaned || null;
}

/** Canonical string form for storage/compare ('' = project root). */
export function folderPathKey(input?: string | null): string {
  return normalizeFolderPath(input) ?? '';
}

/** Whether filePath is under folderPath (inclusive). Both accept raw paths. */
export function isUnderFolder(filePath?: string | null, folderPath?: string | null): boolean {
  const file = folderPathKey(filePath);
  const folder = folderPathKey(folderPath);
  if (folder === '') {
    return true;
  }
  return file === folder || file.startsWith(`${folder}/`);
}

/**
 * Pick the longest matching path prefix among candidates.
 * candidates use raw folderPath values; returns the winning candidate or null.
 */
export function longestMatchingFolderPath<T extends { folderPath: string }>(
  filePath: string | null | undefined,
  candidates: T[],
): T | null {
  const target = folderPathKey(filePath);
  let best: T | null = null;
  let bestLen = -1;

  for (const candidate of candidates) {
    const path = folderPathKey(candidate.folderPath);
    const matches =
      path === '' || target === path || target.startsWith(`${path}/`);
    if (!matches) {
      continue;
    }
    if (path.length > bestLen) {
      best = candidate;
      bestLen = path.length;
    }
  }

  return best;
}
