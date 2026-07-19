import { FileCategory } from '@prisma/client';

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'avi', 'mov', 'wmv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'aac', 'flac']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z']);
const CODE_EXTENSIONS = new Set(['html', 'css', 'js', 'ts', 'json', 'xml']);

export function resolveExtension(filename: string): string {
  const segments = filename.split('.');
  return segments.length > 1 ? String(segments.pop()).toLowerCase() : '';
}

export function resolveFileCategory(filename: string, mimeType: string): FileCategory {
  const extension = resolveExtension(filename);

  if (IMAGE_EXTENSIONS.has(extension) || mimeType.startsWith('image/')) {
    return FileCategory.IMAGE;
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return FileCategory.DOCUMENT;
  }

  if (VIDEO_EXTENSIONS.has(extension) || mimeType.startsWith('video/')) {
    return FileCategory.VIDEO;
  }

  if (AUDIO_EXTENSIONS.has(extension) || mimeType.startsWith('audio/')) {
    return FileCategory.AUDIO;
  }

  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return FileCategory.ARCHIVE;
  }

  if (CODE_EXTENSIONS.has(extension) || mimeType.includes('json') || mimeType.includes('xml')) {
    return FileCategory.CODE;
  }

  return FileCategory.OTHER;
}

const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

/** Office documents cannot be rendered in-browser without a conversion service. */
export function isOfficeDocument(filenameOrExtension: string, mimeType?: string): boolean {
  const raw = filenameOrExtension.includes('.')
    ? resolveExtension(filenameOrExtension)
    : filenameOrExtension.toLowerCase().replace(/^\./, '');
  if (OFFICE_EXTENSIONS.has(raw)) {
    return true;
  }
  const mime = (mimeType || '').toLowerCase();
  return (
    mime.includes('officedocument') ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.ms-powerpoint'
  );
}

const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'log',
  'json',
  'xml',
  'yaml',
  'yml',
  'ini',
  'conf',
  'cfg',
  'env',
  'sql',
  'sh',
  'bat',
  'ps1',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'vue',
]);

export function isTextLikePreview(filename?: string, mimeType?: string): boolean {
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime === 'application/javascript') {
    return true;
  }
  if (!filename) {
    return false;
  }
  return TEXT_PREVIEW_EXTENSIONS.has(resolveExtension(filename));
}

export function isPreviewable(category: FileCategory, mimeType: string, filename?: string): boolean {
  if (([FileCategory.IMAGE, FileCategory.VIDEO, FileCategory.AUDIO] as FileCategory[]).includes(category)) {
    return true;
  }

  // PDF + text/code open in-browser. Office is previewable as a friendly download-only panel.
  if (mimeType === 'application/pdf' || isTextLikePreview(filename, mimeType) || category === FileCategory.CODE) {
    return true;
  }

  if (category === FileCategory.DOCUMENT && filename && isOfficeDocument(filename, mimeType)) {
    return true;
  }

  return isOfficeDocument(filename || '', mimeType);
}
