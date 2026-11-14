const labels: Record<string, string> = {
  PENDING: '等待执行', QUEUED: '排队中', RUNNING: '运行中', PAUSED: '已暂停',
  COMPLETED: '已完成', FAILED: '失败', CANCELED: '已取消',
};

export const taskStatusOptions = Object.entries(labels).map(([value, label]) => ({ value, label }));

export function taskStatusLabel(status: string): string {
  return labels[status] || '未知状态';
}

export function canDeleteTask(task: { status: string }): boolean {
  return ['COMPLETED', 'FAILED', 'CANCELED'].includes(task.status);
}

export function taskTagType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'COMPLETED') return 'success';
  if (status === 'FAILED') return 'danger';
  if (status === 'RUNNING') return 'warning';
  return 'info';
}
