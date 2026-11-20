import type { AxiosRequestConfig } from 'axios';

import { http } from './http';

export interface StorageRemoteFile {
  id: string;
  parentId: string;
  name: string;
  type: 'file' | 'folder';
  size: number | string;
  mimeType?: string;
  sha1?: string;
  updatedAt?: string;
  originalName?: string;
  storageKey?: string;
  checksum?: string;
  project?: { id: string; name: string };
  folderPath?: string;
}

export interface StorageRemoteFilePage {
  parentId: string;
  items: StorageRemoteFile[];
  nextCursor: string | null;
}

export interface StorageRemoteImportResult {
  imported: number;
  failed: number;
  items: Array<{
    id: string;
    name: string;
    status: 'IMPORTED' | 'FAILED';
    fileId?: string;
    projectId?: string;
    projectName?: string;
    error?: string;
  }>;
}

type ReadOptions = Pick<AxiosRequestConfig, 'signal' | '_silent'>;
export interface RemoteJobOptions { signal?: globalThis.AbortSignal; jobId?: string; onJob?: (id: string) => void }
export interface StorageRemoteJob {
  id: string;
  kind: 'IMPORT' | 'DOWNLOAD';
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  result?: StorageRemoteImportResult;
  name?: string;
  size?: number;
  error?: string;
}
export class RemoteJobPendingError extends Error {
  constructor(public readonly jobId: string) {
    super('连接暂时中断，任务仍可能在后台处理中。请继续查询未完成任务，避免重复提交。');
    this.name = 'RemoteJobPendingError';
  }
}
const remotePath = (configId: string) => `/storage-configs/${encodeURIComponent(configId)}/remote-files`;
const jobPath = (configId: string, id: string) => `${remotePath(configId)}/jobs/${encodeURIComponent(id)}`;

function jobMessage(reason: unknown, fallback: string): string {
  const message = (reason as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === 'string' ? message : fallback;
}
function assertNotAborted(signal?: globalThis.AbortSignal): void {
  if (signal?.aborted) throw new globalThis.DOMException('页面已关闭，停止查询；已提交的后台任务会继续处理。', 'AbortError');
}
function waitForNextPoll(signal?: globalThis.AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { globalThis.clearTimeout(timer); reject(new globalThis.DOMException('停止查询后台任务。', 'AbortError')); };
    const timer = globalThis.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function waitForJob(configId: string, id: string, kind: StorageRemoteJob['kind'], options: RemoteJobOptions): Promise<StorageRemoteJob> {
  for (;;) {
    assertNotAborted(options.signal);
    let job: StorageRemoteJob;
    try {
      job = await http.get<unknown, StorageRemoteJob>(jobPath(configId, id), { signal: options.signal, _silent: true });
    } catch (reason) {
      assertNotAborted(options.signal);
      const status = (reason as { response?: { status?: number } })?.response?.status;
      if (status === 404) throw new Error('后台任务已过期或服务已重启，请重新提交。');
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) throw new Error(jobMessage(reason, '暂时无法查询后台任务，请重新登录后重试。'));
      throw new RemoteJobPendingError(id);
    }
    assertNotAborted(options.signal);
    if (job.id !== id || job.kind !== kind) throw new RemoteJobPendingError(id);
    if (job.status === 'FAILED') throw new Error(job.error || '后台取回任务失败，请重试。');
    if (job.status === 'SUCCEEDED') return job;
    if (job.status !== 'RUNNING') throw new RemoteJobPendingError(id);
    await waitForNextPoll(options.signal);
  }
}
async function startJob(configId: string, path: string, kind: StorageRemoteJob['kind'], payload: unknown, options: RemoteJobOptions): Promise<string> {
  if (options.jobId) return options.jobId;
  assertNotAborted(options.signal);
  try {
    const job = await http.post<unknown, StorageRemoteJob>(`${remotePath(configId)}${path}`, payload, { signal: options.signal, _silent: true });
    if (!job?.id || job.kind !== kind) throw new Error('后台任务返回的信息不完整。');
    options.onJob?.(job.id);
    return job.id;
  } catch (reason) {
    assertNotAborted(options.signal);
    throw new Error(`${jobMessage(reason, '取回任务提交未能确认。')} 请求可能已提交，请稍后重试；避免重复操作。`);
  }
}

export const remoteFilesApi = {
  list(configId: string, params: { parentId?: string; cursor?: string } = {}, options: ReadOptions = {}) {
    return http.get<unknown, StorageRemoteFilePage>(remotePath(configId), { params, ...options });
  },
  downloadUrl(configId: string, fileId: string): string {
    return `/api${remotePath(configId)}/${encodeURIComponent(fileId)}/download`;
  },
  async import(configId: string, payload: { projectId?: string; projectIds?: string[]; fileIds: string[]; folderPath?: string; asBackup?: boolean }, options: RemoteJobOptions = {}): Promise<StorageRemoteImportResult> {
    const id = await startJob(configId, '/import-jobs', 'IMPORT', payload, options);
    const job = await waitForJob(configId, id, 'IMPORT', options);
    if (!job.result) throw new Error('后台任务结果不完整，请重新提交。');
    return job.result;
  },
  async prepareDownload(configId: string, fileId: string, options: RemoteJobOptions = {}): Promise<{ id: string; name: string; size: number; url: string }> {
    const id = await startJob(configId, `/${encodeURIComponent(fileId)}/download-jobs`, 'DOWNLOAD', {}, options);
    const job = await waitForJob(configId, id, 'DOWNLOAD', options);
    return { id, name: job.name || fileId, size: job.size || 0, url: `/api${jobPath(configId, id)}/download` };
  },
};
