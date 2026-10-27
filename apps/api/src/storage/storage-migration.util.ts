export type MigrationFailure = { fileId: string; fileName: string; error: string };
export type MigrationProgress = {
  cursor: string;
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
  failures: MigrationFailure[];
};
export type MigrationAttempt = {
  fileId: string;
  fileName?: string;
  outcome: 'migrated' | 'skipped' | 'failed';
  error?: string;
};

export function recordMigrationAttempt(progress: MigrationProgress, attempt: MigrationAttempt): MigrationProgress {
  const failures = attempt.outcome === 'failed'
    ? [...progress.failures, {
        fileId: attempt.fileId,
        fileName: attempt.fileName ?? attempt.fileId,
        error: attempt.error ?? '迁移失败',
      }]
    : progress.failures;
  return {
    cursor: attempt.fileId,
    scanned: progress.scanned + 1,
    migrated: progress.migrated + (attempt.outcome === 'migrated' ? 1 : 0),
    skipped: progress.skipped + (attempt.outcome === 'skipped' ? 1 : 0),
    failed: progress.failed + (attempt.outcome === 'failed' ? 1 : 0),
    failures,
  };
}
