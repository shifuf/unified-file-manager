import { http } from './http';
import type { StoragePluginField } from '../utils/storage-plugin-form';

export interface StoragePluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  fields: StoragePluginField[];
  capabilities: { directUpload?: boolean; usage?: boolean };
  builtin?: boolean;
  available?: boolean;
  error?: string;
  configCount?: number;
}

export const storagePluginsApi = {
  list() { return http.get<unknown, StoragePluginManifest[]>('/storage-plugins'); },
  install(file: File) {
    const body = new FormData();
    body.append('file', file);
    return http.post<unknown, StoragePluginManifest>('/storage-plugins', body);
  },
  remove(id: string) { return http.delete<unknown, { success: boolean }>(`/storage-plugins/${encodeURIComponent(id)}`); },
  download(id: string) { return http.get<unknown, Blob>(`/storage-plugins/${encodeURIComponent(id)}/package`, { responseType: 'blob' }); },
};
