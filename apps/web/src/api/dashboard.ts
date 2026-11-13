import type { AxiosRequestConfig } from 'axios';
import { http } from './http';

export interface DashboardReplicaTotals {
  ready: number;
  pending: number;
  failedOrMissing: number;
  readyBytes: string;
}
export interface DashboardSummary {
  updatedAt: string;
  projects: { total: number; enabled: number };
  files: { active: number; sourceBytes: string };
  storage: { enabled: number };
  replicas: DashboardReplicaTotals;
  tasks: { running: number; failed: number };
}
export interface DashboardTrends {
  updatedAt: string;
  timezone: string;
  days: number;
  items: Array<{ day: string; requests: number; bytes: string }>;
}
export interface DashboardStorageRef {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  priority: number;
}
export interface DashboardStorage extends DashboardStorageRef {
  boundProjects: number;
  health: { status: 'HEALTHY' | 'FAILED' | 'UNKNOWN'; checkedAt: string | null };
  accountUsedBytes: string | null;
  replicas: DashboardReplicaTotals;
}
export interface DashboardPage<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}
export interface DashboardBackup {
  id: string;
  name: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  includeObjects: boolean;
  createdAt: string;
  finishedAt: string | null;
}
export interface DashboardActivity {
  updatedAt: string;
  recentFiles: Array<{
    id: string;
    name: string;
    projectId: string;
    projectName: string;
    size: string;
    createdAt: string;
  }>;
  topProjects: Array<{ id: string; name: string; fileCount: number; sourceBytes: string }>;
  exceptions: {
    recycleFiles: number;
    failedTasks: Array<{
      id: string;
      title: string;
      type: string;
      projectId: string | null;
      createdAt: string;
    }>;
    replicaProjects: Array<{ projectId: string; projectName: string; failedOrMissing: number }>;
  };
  backup: { latest: DashboardBackup | null; lastFailed: DashboardBackup | null };
  projects: DashboardPage<{
    id: string;
    name: string;
    enabled: boolean;
    fileCount: number;
    storages: DashboardStorageRef[];
  }>;
}
type ReadOptions = Pick<AxiosRequestConfig, 'signal' | '_silent'>;
export const dashboardApi = {
  summary(options: ReadOptions = {}) {
    return http.get<unknown, DashboardSummary>('/dashboard/summary', options);
  },
  trends(days: 7 | 30, options: ReadOptions = {}) {
    return http.get<unknown, DashboardTrends>('/dashboard/trends', {
      ...options,
      params: { days },
    });
  },
  storage(page: number, pageSize: number, options: ReadOptions = {}) {
    return http.get<unknown, DashboardPage<DashboardStorage> & { updatedAt: string }>(
      '/dashboard/storage',
      { ...options, params: { page, pageSize } },
    );
  },
  activity(page: number, pageSize: number, options: ReadOptions = {}) {
    return http.get<unknown, DashboardActivity>('/dashboard/activity', {
      ...options,
      params: { page, pageSize },
    });
  },
};
