import type { Prisma } from '@prisma/client';

export type DownloadStatInput = {
  projectId: string;
  fileId?: string | null;
  originalName?: string | null;
  bytes: number;
  source: DownloadSourceValue;
  actorId?: string | null;
  shareId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  referer?: string | null;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  success?: boolean;
  message?: string | null;
};

export type DownloadSourceValue =
  | 'ADMIN'
  | 'OPEN_API'
  | 'PUBLIC'
  | 'SHARE'
  | 'FOLDER_SHARE'
  | 'WEBDAV'
  | 'BATCH';

export type DownloadStatsFilter = {
  projectId?: string;
  fileId?: string;
  source?: DownloadSourceValue;
  from?: Date;
  to?: Date;
};

export type DownloadRecordView = {
  id: string;
  projectId: string;
  fileId: string | null;
  originalName: string | null;
  bytes: number;
  source: DownloadSourceValue;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  referer: string | null;
  createdAt: Date;
};

export type DownloadHourlyBucket = {
  day: string;
  count: number;
  bytes: number;
};

export type DownloadSummary = {
  totalCount: number;
  totalBytes: number;
  successCount: number;
  failedCount: number;
  bySource: Array<{ source: DownloadSourceValue; count: number; bytes: number }>;
  byFile: Array<{
    fileId: string | null;
    originalName: string | null;
    count: number;
    bytes: number;
  }>;
  byDay: DownloadHourlyBucket[];
  topIps: Array<{ ip: string; count: number; bytes: number }>;
};

/** Prisma type aliases kept here so the service file stays readable. */
export type DownloadDailyStatWhere = Prisma.DownloadDailyStatWhereInput;
