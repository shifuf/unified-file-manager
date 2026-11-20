/** Only web links may navigate from a share record supplied by the API. */
export function safeShareUrl(value: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value, globalThis.location.origin);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
