import type { FileCategory } from '../types';
const labels: Record<FileCategory, string> = {
  IMAGE: '图片', DOCUMENT: '文档', VIDEO: '视频', AUDIO: '音频', ARCHIVE: '压缩包', CODE: '代码', OTHER: '其他',
};
export function fileCategoryLabel(category: string): string { return labels[category as FileCategory] || '其他'; }
