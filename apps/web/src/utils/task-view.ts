const labels: Record<string, string> = {
  PENDING: '等待执行', QUEUED: '排队中', RUNNING: '运行中', PAUSED: '已暂停',
  COMPLETED: '已完成', FAILED: '失败', CANCELED: '已取消',
};

export const taskStatusOptions = Object.entries(labels).map(([value, label]) => ({ value, label }));

const typeLabels: Record<string, string> = {
  FILE_BATCH_MOVE: '批量移动文件', FILE_BATCH_COPY: '批量复制文件', FILE_BATCH_DELETE: '批量移入回收站',
  FILE_BATCH_RESTORE: '批量恢复文件', FILE_BATCH_PURGE: '批量彻底删除', STORAGE_MIGRATION: '存储迁移',
  LOCAL_FILE_MIGRATION: '本地文件迁移', STORAGE_REPLICA_SYNC: '存储副本同步',
  PROJECT_STORAGE_PURGE: '项目存储清理', PROJECT_IMPORT: '项目导入',
};
export const taskTypeOptions = Object.entries(typeLabels).map(([value, label]) => ({ value, label }));
export function taskTypeLabel(type: string): string { return typeLabels[type] || '其他任务'; }

export function taskStatusLabel(status: string): string {
  return labels[status] || '未知状态';
}

export function canDeleteTask(task: { status: string }): boolean {
  return ['COMPLETED', 'FAILED', 'CANCELED'].includes(task.status);
}

export function canRetryTask(task: { status: string; type: string; projectId?: string | null; detail?: unknown; result?: unknown }): boolean {
  if (task.status !== 'FAILED') return false;
  if (['STORAGE_MIGRATION', 'STORAGE_REPLICA_SYNC'].includes(task.type)) return true;
  if (task.type !== 'FILE_BATCH_PURGE' || !task.projectId) return false;
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const validIds = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.length <= 1000
    && value.every(id => typeof id === 'string' && !!id.trim() && id.length <= 128);
  const detail = record(task.detail), result = record(task.result);
  return validIds(detail.failedFileIds) || validIds(detail.fileIds)
    || [detail.failures, result.failures].some(failures => Array.isArray(failures) && validIds(failures.map(failure => record(failure).fileId)));
}

export function taskTagType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'COMPLETED') return 'success';
  if (status === 'FAILED') return 'danger';
  if (status === 'RUNNING') return 'warning';
  return 'info';
}
