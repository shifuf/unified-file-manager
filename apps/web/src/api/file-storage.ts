import type { AxiosRequestConfig } from 'axios';
import type { FileReplicaDetail, ManagedFile } from '@/types';
import { http } from './http';

type ReadOptions = Pick<AxiosRequestConfig, 'signal' | '_silent'>;
export const fileStorageApi = {
  batch(fileIds: string[], options: ReadOptions = {}) {
    return http.get<unknown, { items: FileReplicaDetail[] }>('/files/storage-replicas', { ...options, params: { fileIds: fileIds.join(',') } });
  },
  detail(fileId: string, options: ReadOptions = {}) {
    return http.get<unknown, FileReplicaDetail>(`/files/${fileId}/storage-replicas`, options);
  },
  file(fileId: string, options: ReadOptions = {}) {
    return http.get<unknown, ManagedFile>(`/files/${fileId}`, options);
  },
  sync(fileId: string, configIds: string[]) {
    return http.post<unknown, Pick<FileReplicaDetail, 'fileId' | 'projectId' | 'currentVersion' | 'items'> & { queued: number }>(`/files/${fileId}/storage-replicas/sync`, { configIds }, { _silent: true });
  },
};
