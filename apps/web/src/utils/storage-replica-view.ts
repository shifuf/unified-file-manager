import type { FileReplicaDetail, FileStorageLocation, ManagedFile } from '../types';

const labels: Record<FileStorageLocation['status'], string> = {
  READY: '已上传', PENDING: '等待同步', SYNCING: '同步中', FAILED: '失败',
  MISSING: '缺失', SKIPPED: '已跳过', NOT_SYNCED: '未同步', UNVERIFIED: '待校验',
};
export function replicaLabel(location: FileStorageLocation): string {
  const suffix = !location.enabled ? ' · 已停用' : !location.assigned && !location.desired ? ' · 未绑定' : '';
  return (labels[location.status] || '未知') + suffix;
}
export function replicaTagType(location: FileStorageLocation): 'success' | 'warning' | 'danger' | 'info' {
  if (!location.enabled || (!location.assigned && !location.desired)) return 'info';
  if (location.status === 'READY') return 'success';
  if (location.status === 'FAILED' || location.status === 'MISSING') return 'danger';
  return 'warning';
}
export function canSyncReplica(location: FileStorageLocation): boolean {
  return location.desired && location.enabled && ['NOT_SYNCED', 'UNVERIFIED', 'FAILED', 'MISSING', 'SKIPPED'].includes(location.status);
}
export function hasPendingReplicas(locations: FileStorageLocation[]): boolean {
  return locations.some(item => item.desired && item.enabled && ['NOT_SYNCED', 'PENDING', 'SYNCING'].includes(item.status));
}
export function replicaSnapshotMatches(file: Pick<ManagedFile, 'id' | 'projectId' | 'currentVersion'>, snapshot: FileReplicaDetail): boolean {
  return file.id === snapshot.fileId && file.projectId === snapshot.projectId && (file.currentVersion || 1) === snapshot.currentVersion;
}
export function shouldAcceptReplicaSnapshot(file: Pick<ManagedFile, 'id' | 'projectId' | 'currentVersion'>,
  snapshot: FileReplicaDetail, existing?: FileReplicaDetail | null): boolean {
  if (!replicaSnapshotMatches(file, snapshot) || !Number.isFinite(new Date(snapshot.updatedAt).getTime())) return false;
  if (!existing) return true;
  if (existing.fileId !== snapshot.fileId || existing.projectId !== snapshot.projectId) return false;
  // Head versions take precedence over observation time. For one immutable
  // head, keep the first snapshot on ties instead of allowing a late old read.
  if (existing.currentVersion !== snapshot.currentVersion) return existing.currentVersion < snapshot.currentVersion;
  return existing.storageKey === snapshot.storageKey && new Date(existing.updatedAt).getTime() < new Date(snapshot.updatedAt).getTime();
}
export function localReplicaResult(locations: FileStorageLocation[] | null): string {
  if (!locations) return '本地状态待确认';
  const local = locations.find(item => item.provider === 'LOCAL' && item.desired && item.enabled);
  if (!local) return '本地未同步';
  if (local.status === 'READY') return local.verifiedAt ? '本地已保存' : '本地待校验';
  return `本地${labels[local.status] || '状态待确认'}`;
}
