import type { FileReplicaDetail, FileStorageLocation, ManagedFile } from '../types';

export function storageProviderLabel(provider: string): string {
  return ({ LOCAL: '本地存储', QINIU: '七牛云', UPYUN: '又拍云', ALIYUN: '阿里云 OSS', S3: 'S3' } as Record<string, string>)[provider] || provider;
}
export function downloadLocations(locations: FileStorageLocation[] | null): FileStorageLocation[] {
  return (locations || []).filter(item => item.enabled && (item.desired || item.assigned))
    .slice().sort((a, b) => Number(a.provider === 'LOCAL') - Number(b.provider === 'LOCAL') || a.priority - b.priority || a.configId.localeCompare(b.configId));
}
export function preferredDownloadLabel(locations: FileStorageLocation[] | null): string {
  if (!locations) return '下载优先存储待确认';
  const first = downloadLocations(locations)[0];
  if (!first) return '暂无启用的下载存储';
  return `${first.provider === 'LOCAL' ? '下载存储' : '优先下载'}：${first.configName}（${storageProviderLabel(first.provider)}）`;
}
export function downloadOrderLabel(locations: FileStorageLocation[] | null): string {
  return downloadLocations(locations).map(item => `${item.configName}${item.provider === 'LOCAL' ? '（兜底）' : ''}`).join(' → ');
}

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
