import { http } from './http';

export interface StorageProjectSyncResult {
  queuedProjects: number;
  projects: Array<{ projectId: string; projectName: string; taskId: string; requeued: number }>;
}

export function syncProjectsToStorage(configId: string, projectIds: string[]): Promise<StorageProjectSyncResult> {
  return http.post<unknown, StorageProjectSyncResult>(`/storage-configs/${encodeURIComponent(configId)}/project-sync`, { projectIds }, { _silent: true });
}
