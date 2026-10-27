export type DavNode = {
  /** Slash-separated path relative to the project root, '' = root. */
  path: string;
  name: string;
  isCollection: boolean;
  size: number | null;
  mimeType: string | null;
  updatedAt: Date | null;
  fileId: string | null;
};

/** Percent-decode a single URL segment, tolerating malformed input. */
export function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Normalize a WebDAV request path into a project-relative path. Traversal
 * segments (`.` / `..`) are dropped instead of resolved, so no request can escape
 * the project root.
 */
export function normalizeDavPath(rawPath: string): string {
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }

  return decoded
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

export function parentDavPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function davBaseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function encodeHrefPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
