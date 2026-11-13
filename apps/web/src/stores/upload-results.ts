import { reactive } from 'vue';
import type { ManagedFile } from '@/types';

export const uploadResults = reactive({ projectId: '', projectName: '', files: [] as ManagedFile[], startedAt: '', finishedAt: '' });
export function retainUploadedFiles(files: ManagedFile[]): void {
  const merged = new Map(uploadResults.files.map(file => [file.id, file]));
  files.forEach(file => merged.set(file.id, file));
  uploadResults.files = [...merged.values()];
}
