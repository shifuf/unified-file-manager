import { http } from './http';
import type { StoragePluginField } from '../utils/storage-plugin-form';

export interface StoragePluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  description?: string;
  fields: StoragePluginField[];
  capabilities: { directUpload?: boolean; usage?: boolean; authentication?: boolean; backupOnly?: boolean };
  builtin?: boolean;
  available?: boolean;
  error?: string;
  configCount?: number;
}

export interface PluginAccount {
  accountId: string; userId: string; name: string; connected: boolean; drives: Array<{ id: string; name: string }>;
}
export interface PluginLoginSession { sessionId: string; qrCode: string; expiresAt: string }
export interface PluginLoginResult { status: 'WAITING' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED'; account?: PluginAccount }
const authPath = (id: string) => `/storage-plugins/${encodeURIComponent(id)}/auth`;

export const storagePluginsApi = {
  startLogin(id: string, accountId?: string) { return http.post<unknown, PluginLoginSession>(`${authPath(id)}/sessions`, { accountId }); },
  pollLogin(id: string, sessionId: string) { return http.get<unknown, PluginLoginResult>(`${authPath(id)}/sessions/${encodeURIComponent(sessionId)}`); },
  cancelLogin(id: string, sessionId: string) { return http.delete(`${authPath(id)}/sessions/${encodeURIComponent(sessionId)}`); },
  accountStatus(id: string, accountId: string) { return http.get<unknown, PluginAccount>(`${authPath(id)}/accounts/${encodeURIComponent(accountId)}`); },
  disconnectAccount(id: string, accountId: string) { return http.delete(`${authPath(id)}/accounts/${encodeURIComponent(accountId)}`); },
  list() { return http.get<unknown, StoragePluginManifest[]>('/storage-plugins'); },
  install(file: File) {
    const body = new FormData();
    body.append('file', file);
    return http.post<unknown, StoragePluginManifest>('/storage-plugins', body);
  },
  remove(id: string) { return http.delete<unknown, { success: boolean }>(`/storage-plugins/${encodeURIComponent(id)}`); },
  download(id: string) { return http.get<unknown, Blob>(`/storage-plugins/${encodeURIComponent(id)}/package`, { responseType: 'blob' }); },
};
