import {
  Connection,
  DataAnalysis,
  Delete,
  Files,
  Folder,
  FolderOpened,
  Guide,
  Link,
  List,
  Memo,
  Monitor,
  Position,
  Setting,
  Warning,
} from '@element-plus/icons-vue';
import type { Component } from 'vue';

export interface AdminGroup {
  label: string;
  adminOnly?: boolean;
  items: Array<{ path: string; label: string; icon: Component }>;
}

export const adminNavigation: AdminGroup[] = [
  {
    label: '工作空间',
    items: [
      { path: '/dashboard', label: '概览', icon: DataAnalysis },
      { path: '/projects', label: '项目管理', icon: Folder },
      { path: '/files', label: '文件管理', icon: Files },
      { path: '/shares', label: '分享管理', icon: Link },
      { path: '/recycle-bin', label: '回收站', icon: Delete },
    ],
  },
  {
    label: '服务与集成',
    items: [
      { path: '/storage-configs', label: '存储配置', icon: Connection },
      { path: '/tasks', label: '任务中心', icon: List },
      { path: '/developer-integration', label: '开发对接', icon: Guide },
      { path: '/webhooks', label: '出站 Webhook', icon: Position },
    ],
  },
  {
    label: '系统管理',
    adminOnly: true,
    items: [
      { path: '/system-health', label: '系统健康', icon: Monitor },
      { path: '/backups', label: '备份管理', icon: FolderOpened },
      { path: '/audit-logs', label: '日志审计', icon: Memo },
      { path: '/share-ip-abuse', label: 'IP 防刷', icon: Warning },
      { path: '/settings', label: '系统设置', icon: Setting },
    ],
  },
];
