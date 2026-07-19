import { ElMessage } from 'element-plus';

/**
 * Copy text to the clipboard. `navigator.clipboard` is undefined on insecure
 * (plain-HTTP, non-localhost) origins, so this falls back to a hidden textarea +
 * `execCommand('copy')`. Shows a success/failure toast unless `silent` is set.
 */
export async function copyText(value: string, options: { silent?: boolean } = {}): Promise<boolean> {
  const ok = await writeToClipboard(value);

  if (!options.silent) {
    if (ok) {
      ElMessage.success('已复制。');
    } else {
      ElMessage.error('复制失败，请手动复制。');
    }
  }

  return ok;
}

async function writeToClipboard(value: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Insecure context or permission denied — fall back to the legacy path.
  }

  return legacyCopy(value);
}

function legacyCopy(value: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** Trigger a browser download for a Blob and release the temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
