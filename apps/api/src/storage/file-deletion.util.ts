// RECYCLED keeps a failed physical deletion visible and retryable. An epoch
// purge deadline is reserved for durable whole-file deletion intent; ordinary
// recycling always schedules a future deadline. No schema migration is needed.
export const FILE_DELETION_PURGE_AT = new Date(0);

export function isFileDeletionFrozen(file: { status?: string; purgeAt?: Date | null }): boolean {
  return file.status === 'RECYCLED' && file.purgeAt?.getTime() === 0;
}
