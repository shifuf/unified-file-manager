<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">日志审计</h1>
        <p class="page-subtitle">按项目、动作、关键字和时间范围追踪登录、项目、存储配置、文件与安全操作。</p>
      </div>
      <div class="toolbar">
        <el-button @click="exportLogs('csv')">导出 CSV</el-button>
        <el-button @click="exportLogs('json')">导出 JSON</el-button>
        <el-button :icon="Delete" type="danger" plain @click="openCleanupDialog">清理日志</el-button>
        <el-button :icon="Refresh" @click="loadLogs">刷新</el-button>
      </div>
    </div>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar log-toolbar">
          <el-input
            v-model="filters.keyword"
            clearable
            placeholder="搜索操作人、项目、IP、User-Agent"
            style="width: 300px"
            :prefix-icon="Search"
            @keyup.enter="searchLogs"
            @clear="searchLogs"
          />
          <el-select v-model="filters.projectId" clearable filterable placeholder="全部项目" style="width: 220px" @change="searchLogs">
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-select v-model="filters.action" clearable placeholder="全部动作" style="width: 220px" @change="searchLogs">
            <el-option
              v-for="action in actionOptions"
              :key="action"
              :label="actionMeta(action).label"
              :value="action"
            />
          </el-select>
          <el-date-picker
            v-model="filters.dateRange"
            type="datetimerange"
            value-format="YYYY-MM-DDTHH:mm:ss"
            start-placeholder="开始时间"
            end-placeholder="结束时间"
            @change="searchLogs"
          />
          <el-button :icon="Search" type="primary" @click="searchLogs">查询</el-button>
          <el-button @click="resetFilters">重置</el-button>
        </div>

        <el-table v-loading="loading" :data="result.items" row-key="id" class="data-table">
          <el-table-column label="动作" min-width="170">
            <template #default="{ row }">
              <el-tag :type="actionMeta(row.action).type">{{ actionMeta(row.action).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作人" min-width="150">
            <template #default="{ row }">{{ row.actor?.displayName || row.actor?.username || '开放接口' }}</template>
          </el-table-column>
          <el-table-column label="项目" min-width="170">
            <template #default="{ row }">{{ row.project?.name || '-' }}</template>
          </el-table-column>
          <el-table-column prop="ip" label="IP" min-width="130" />
          <el-table-column label="详情" min-width="260" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="mono">{{ formatValue(row.detail || {}) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="时间" min-width="180">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="90">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">详情</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pagination-row">
          <el-pagination
            v-model:current-page="result.page"
            v-model:page-size="result.pageSize"
            :page-sizes="[10, 20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            :total="result.total"
            @change="loadLogs"
          />
        </div>
      </div>
    </section>

    <el-drawer v-model="detailVisible" title="日志详情" size="520px">
      <div v-if="selectedLog" class="log-detail">
        <div class="detail-row">
          <span class="muted">动作</span>
          <el-tag :type="actionMeta(selectedLog.action).type">{{ actionMeta(selectedLog.action).label }}</el-tag>
        </div>
        <div class="detail-row">
          <span class="muted">操作人</span>
          <span>{{ selectedLog.actor?.displayName || selectedLog.actor?.username || '开放接口' }}</span>
        </div>
        <div class="detail-row">
          <span class="muted">项目</span>
          <span>{{ selectedLog.project?.name || '-' }}</span>
        </div>
        <div class="detail-row">
          <span class="muted">IP</span>
          <span>{{ selectedLog.ip || '-' }}</span>
        </div>
        <div class="detail-row">
          <span class="muted">User-Agent</span>
          <span class="breakable">{{ selectedLog.userAgent || '-' }}</span>
        </div>
        <div class="detail-row">
          <span class="muted">时间</span>
          <span>{{ formatTime(selectedLog.createdAt) }}</span>
        </div>
        <pre class="detail-json">{{ formatJson(selectedLog.detail || {}) }}</pre>
      </div>
    </el-drawer>

    <el-dialog v-model="cleanupVisible" title="清理日志" width="520px">
      <el-form label-position="top">
        <el-form-item label="清理早于">
          <el-date-picker
            v-model="cleanupForm.beforeAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ss"
            placeholder="选择截止时间"
            class="cleanup-date"
          />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="cleanupForm.useCurrentFilters">只清理当前筛选条件匹配的日志</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cleanupVisible = false">取消</el-button>
        <el-button type="danger" :loading="cleanupLoading" @click="cleanupLogs">确认清理</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Delete, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';

import { projectApi, settingsApi } from '@/api/modules';
import type { AuditAction, AuditLog, PageResult, Project } from '@/types';
import { saveBlob } from '@/utils/io';

type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger';

const actionOptions: AuditAction[] = [
  'LOGIN',
  'USER_CREATE',
  'USER_UPDATE',
  'USER_DISABLE',
  'USER_PASSWORD_CHANGE',
  'USER_2FA_ENABLE',
  'USER_2FA_DISABLE',
  'PROJECT_CREATE',
  'PROJECT_UPDATE',
  'PROJECT_DELETE',
  'PROJECT_MEMBER_ADD',
  'PROJECT_MEMBER_UPDATE',
  'PROJECT_MEMBER_REMOVE',
  'PROJECT_SECRET_RESET',
  'PROJECT_SECRET_CREATE',
  'PROJECT_SECRET_DISABLE',
  'PROJECT_EXPORT',
  'PROJECT_IMPORT',
  'CDN_CREATE',
  'CDN_UPDATE',
  'CDN_ACTIVATE',
  'CDN_DELETE',
  'CDN_HEALTH_CHECK',
  'FILE_UPLOAD',
  'FILE_DOWNLOAD',
  'FILE_UPDATE',
  'FILE_DELETE',
  'FILE_RESTORE',
  'FILE_PURGE',
  'FILE_MOVE',
  'FILE_COPY',
  'FILE_BATCH_DELETE',
  'FILE_BATCH_RESTORE',
  'FILE_BATCH_PURGE',
  'FILE_BATCH_MOVE',
  'FILE_BATCH_COPY',
  'FILE_SHARE_CREATE',
  'FILE_SHARE_UPDATE',
  'FILE_SHARE_DELETE',
  'FILE_SHARE_DOWNLOAD',
  'FILE_SCAN',
  'FILE_QUARANTINE',
  'FILE_PUBLISH',
  'FILE_UNPUBLISH',
  'SETTING_UPDATE',
  'AUDIT_LOG_CLEANUP',
  'TASK_CREATE',
  'TASK_UPDATE',
  'TASK_CANCEL',
  'TASK_RETRY',
  'TASK_DELETE',
  'SYSTEM_HEALTH_CHECK',
  'NOTIFY_TEST',
  'NOTIFY_SEND',
  'UPLOAD_CREDENTIAL_CREATE',
  'UPLOAD_CREDENTIAL_REVOKE',
  'WEBHOOK_DELIVERY',
  'WEBHOOK_CREATE',
  'WEBHOOK_UPDATE',
  'WEBHOOK_DELETE',
  'FOLDER_PUBLIC_SET',
  'FOLDER_PUBLIC_UNSET',
  'FOLDER_BATCH_PUBLISH',
  'FILE_VERSION_CREATE',
  'FILE_VERSION_RESTORE',
  'STORAGE_MIGRATE',
  'SESSION_REVOKE',
  'LIFECYCLE_RUN',
  'FOLDER_SHARE_CREATE',
  'FOLDER_SHARE_UPDATE',
  'FOLDER_SHARE_DELETE',
  'FOLDER_SHARE_DOWNLOAD',
  'NOTIFICATION_READ',
  'AUDIT_EXPORT',
  'FILE_QUARANTINE_RELEASE',
];
const actionLabels: Record<AuditAction, { label: string; type: TagType }> = {
  LOGIN: { label: '登录', type: 'primary' },
  USER_CREATE: { label: '创建用户', type: 'success' },
  USER_UPDATE: { label: '更新用户', type: 'primary' },
  USER_DISABLE: { label: '停用用户', type: 'warning' },
  USER_PASSWORD_CHANGE: { label: '修改密码', type: 'warning' },
  USER_2FA_ENABLE: { label: '启用 2FA', type: 'success' },
  USER_2FA_DISABLE: { label: '关闭 2FA', type: 'warning' },
  PROJECT_CREATE: { label: '创建项目', type: 'success' },
  PROJECT_UPDATE: { label: '更新项目', type: 'primary' },
  PROJECT_DELETE: { label: '删除项目', type: 'danger' },
  PROJECT_MEMBER_ADD: { label: '添加项目成员', type: 'success' },
  PROJECT_MEMBER_UPDATE: { label: '更新项目成员', type: 'primary' },
  PROJECT_MEMBER_REMOVE: { label: '移除项目成员', type: 'warning' },
  PROJECT_SECRET_RESET: { label: '重置密钥', type: 'warning' },
  PROJECT_SECRET_CREATE: { label: '新增密钥', type: 'success' },
  PROJECT_SECRET_DISABLE: { label: '停用密钥', type: 'warning' },
  PROJECT_EXPORT: { label: '导出项目', type: 'primary' },
  PROJECT_IMPORT: { label: '导入项目', type: 'success' },
  CDN_CREATE: { label: '创建存储配置', type: 'success' },
  CDN_UPDATE: { label: '更新存储配置', type: 'primary' },
  CDN_ACTIVATE: { label: '切换项目存储', type: 'warning' },
  CDN_DELETE: { label: '删除存储配置', type: 'danger' },
  CDN_HEALTH_CHECK: { label: '存储健康检查', type: 'primary' },
  FILE_UPLOAD: { label: '上传文件', type: 'success' },
  FILE_DOWNLOAD: { label: '下载文件', type: 'primary' },
  FILE_UPDATE: { label: '更新文件', type: 'primary' },
  FILE_DELETE: { label: '移入回收站', type: 'warning' },
  FILE_RESTORE: { label: '恢复文件', type: 'success' },
  FILE_PURGE: { label: '彻底删除文件', type: 'danger' },
  FILE_MOVE: { label: '移动文件', type: 'primary' },
  FILE_COPY: { label: '复制文件', type: 'success' },
  FILE_BATCH_DELETE: { label: '批量删除', type: 'warning' },
  FILE_BATCH_RESTORE: { label: '批量恢复', type: 'success' },
  FILE_BATCH_PURGE: { label: '批量彻底删除', type: 'danger' },
  FILE_BATCH_MOVE: { label: '批量移动', type: 'primary' },
  FILE_BATCH_COPY: { label: '批量复制', type: 'success' },
  FILE_SHARE_CREATE: { label: '创建分享', type: 'success' },
  FILE_SHARE_UPDATE: { label: '更新分享', type: 'primary' },
  FILE_SHARE_DELETE: { label: '停用分享', type: 'warning' },
  FILE_SHARE_DOWNLOAD: { label: '分享下载', type: 'primary' },
  FILE_SCAN: { label: '病毒扫描', type: 'primary' },
  FILE_QUARANTINE: { label: '文件隔离', type: 'danger' },
  FILE_PUBLISH: { label: '发布到资源库', type: 'success' },
  FILE_UNPUBLISH: { label: '取消资源库发布', type: 'warning' },
  SETTING_UPDATE: { label: '更新设置', type: 'warning' },
  AUDIT_LOG_CLEANUP: { label: '清理审计日志', type: 'danger' },
  TASK_CREATE: { label: '创建任务', type: 'primary' },
  TASK_UPDATE: { label: '更新任务', type: 'primary' },
  TASK_CANCEL: { label: '取消任务', type: 'warning' },
  TASK_RETRY: { label: '重试任务', type: 'primary' },
  TASK_DELETE: { label: '删除任务', type: 'danger' },
  SYSTEM_HEALTH_CHECK: { label: '系统健康检查', type: 'primary' },
  NOTIFY_TEST: { label: '通知测试', type: 'primary' },
  NOTIFY_SEND: { label: '发送通知', type: 'success' },
  UPLOAD_CREDENTIAL_CREATE: { label: '创建上传凭证', type: 'success' },
  UPLOAD_CREDENTIAL_REVOKE: { label: '吊销上传凭证', type: 'warning' },
  WEBHOOK_DELIVERY: { label: 'Webhook 投递', type: 'primary' },
  WEBHOOK_CREATE: { label: '创建 Webhook', type: 'success' },
  WEBHOOK_UPDATE: { label: '更新 Webhook', type: 'primary' },
  WEBHOOK_DELETE: { label: '删除 Webhook', type: 'danger' },
  FOLDER_PUBLIC_SET: { label: '设置文件夹公开', type: 'success' },
  FOLDER_PUBLIC_UNSET: { label: '取消文件夹公开', type: 'warning' },
  FOLDER_BATCH_PUBLISH: { label: '批量公开文件', type: 'primary' },
  FILE_VERSION_CREATE: { label: '创建文件版本', type: 'success' },
  FILE_VERSION_RESTORE: { label: '恢复文件版本', type: 'warning' },
  STORAGE_MIGRATE: { label: '存储迁移', type: 'primary' },
  SESSION_REVOKE: { label: '吊销会话', type: 'warning' },
  LIFECYCLE_RUN: { label: '生命周期执行', type: 'primary' },
  FOLDER_SHARE_CREATE: { label: '创建目录分享', type: 'success' },
  FOLDER_SHARE_UPDATE: { label: '更新目录分享', type: 'primary' },
  FOLDER_SHARE_DELETE: { label: '删除目录分享', type: 'warning' },
  FOLDER_SHARE_DOWNLOAD: { label: '目录分享下载', type: 'primary' },
  NOTIFICATION_READ: { label: '阅读通知', type: 'info' },
  AUDIT_EXPORT: { label: '导出审计日志', type: 'primary' },
  FILE_QUARANTINE_RELEASE: { label: '放行隔离文件', type: 'success' },
};
const settingLabels: Record<string, string> = {
  key: '配置项',
  maxFileSizeMb: '单个文件大小',
  maxBatchUploadCount: '单次上传数量',
  recycleRetentionDays: '回收站保留天数',
  requireHttps: 'HTTPS 访问要求',
  publicFileAllowedDomains: '公开文件允许访问域名',
  username: '用户名',
  provider: '存储平台',
  name: '名称',
  originalName: '文件名',
  size: '大小',
};
const loading = ref(false);
const detailVisible = ref(false);
const cleanupVisible = ref(false);
const cleanupLoading = ref(false);
const selectedLog = ref<AuditLog | null>(null);
const projects = ref<Project[]>([]);
const filters = reactive<{
  keyword: string;
  projectId: string;
  action: AuditAction | '';
  dateRange: string[] | null;
}>({
  keyword: '',
  projectId: '',
  action: '',
  dateRange: [],
});
const result = reactive<PageResult<AuditLog>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});
const cleanupForm = reactive({
  beforeAt: '',
  useCurrentFilters: true,
});

function actionMeta(action: AuditAction): { label: string; type: TagType } {
  return actionLabels[action] || { label: action, type: 'info' };
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatValue(item)).join('、');
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length > 0
      ? entries.map(([key, item]) => `${settingLabels[key] || key}=${formatValue(item)}`).join('；')
      : '-';
  }

  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }

  return String(value);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function openDetail(log: AuditLog): void {
  selectedLog.value = log;
  detailVisible.value = true;
}

function searchLogs(): void {
  result.page = 1;
  void loadLogs();
}

function resetFilters(): void {
  filters.keyword = '';
  filters.projectId = '';
  filters.action = '';
  filters.dateRange = [];
  searchLogs();
}

function openCleanupDialog(): void {
  cleanupForm.beforeAt = '';
  cleanupForm.useCurrentFilters = true;
  cleanupVisible.value = true;
}

async function cleanupLogs(): Promise<void> {
  if (!cleanupForm.beforeAt) {
    ElMessage.warning('请选择清理截止时间。');
    return;
  }

  await ElMessageBox.confirm('清理后日志不可恢复，确认继续？', '清理日志', {
    type: 'warning',
    confirmButtonText: '确认清理',
    cancelButtonText: '取消',
  });

  cleanupLoading.value = true;
  try {
    const result = await settingsApi.cleanupAuditLogs({
      beforeAt: cleanupForm.beforeAt,
      ...(cleanupForm.useCurrentFilters
        ? {
            keyword: filters.keyword || undefined,
            projectId: filters.projectId || undefined,
            action: filters.action || undefined,
          }
        : {}),
    });
    cleanupVisible.value = false;
    ElMessage.success(`已清理 ${result.deleted} 条日志。`);
    await loadLogs();
  } finally {
    cleanupLoading.value = false;
  }
}

async function loadLogs(): Promise<void> {
  loading.value = true;
  try {
    const logs = await settingsApi.auditLogs({
      page: result.page,
      pageSize: result.pageSize,
      keyword: filters.keyword || undefined,
      projectId: filters.projectId || undefined,
      action: filters.action || undefined,
      startAt: filters.dateRange?.[0] || undefined,
      endAt: filters.dateRange?.[1] || undefined,
    });
    result.items = logs.items;
    result.total = logs.total;
    result.page = logs.page;
    result.pageSize = logs.pageSize;
  } finally {
    loading.value = false;
  }
}

async function exportLogs(format: 'csv' | 'json'): Promise<void> {
  const blob = await settingsApi.exportAuditLogs({
    format,
    keyword: filters.keyword || undefined,
    projectId: filters.projectId || undefined,
    action: filters.action || undefined,
    startAt: filters.dateRange?.[0] || undefined,
    endAt: filters.dateRange?.[1] || undefined,
  });
  saveBlob(blob, `audit-logs-${Date.now()}.${format}`);
  ElMessage.success('导出已开始下载。');
}

async function loadProjects(): Promise<void> {
  projects.value = await projectApi.list();
}

onMounted(async () => {
  await Promise.all([loadProjects(), loadLogs()]);
});
</script>

<style scoped>
.log-toolbar {
  margin-bottom: 14px;
}

.cleanup-date {
  width: 100%;
}

.pagination-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.log-detail {
  display: grid;
  gap: 12px;
}

.detail-row {
  display: grid;
  gap: 6px;
}

.breakable {
  overflow-wrap: anywhere;
}

.detail-json {
  min-height: 160px;
  margin: 4px 0 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  font-family: "Fira Code", "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}
</style>
