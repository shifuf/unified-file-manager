<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">分享管理</h1>
        <p class="page-subtitle">集中查看分享链接、有效期、下载次数、自定义后缀与访问控制。</p>
      </div>
      <el-button :icon="Refresh" @click="reload">刷新</el-button>
    </div>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar">
          <el-select v-model="filters.projectId" clearable filterable placeholder="全部项目" style="width: 240px" @change="search">
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-input
            v-model="filters.keyword"
            clearable
            placeholder="文件名、token 或自定义后缀"
            style="width: 280px"
            :prefix-icon="Search"
            @keyup.enter="search"
            @clear="search"
          />
          <el-select v-model="filters.status" clearable placeholder="状态" style="width: 150px" @change="search">
            <el-option label="有效" value="ACTIVE" />
            <el-option label="停用" value="DISABLED" />
            <el-option label="已过期" value="EXPIRED" />
            <el-option label="次数耗尽" value="EXHAUSTED" />
          </el-select>
        </div>

        <el-table v-loading="loading" :data="pageResult.items" row-key="id" class="data-table">
          <el-table-column label="文件" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="file-cell">
                <span>{{ row.fileName }}</span>
                <span class="muted">{{ row.projectName || row.projectId }} · {{ formatSize(row.fileSize) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="链接" min-width="300">
            <template #default="{ row }">
              <div class="link-cell">
                <span class="mono">{{ row.url }}</span>
                <span v-if="row.customPath" class="muted">自定义：/s/{{ row.customPath }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="限制" min-width="140">
            <template #default="{ row }">
              <div class="file-cell">
                <span>{{ row.hasPassword ? '需要密码' : '无密码' }}</span>
                <span class="muted">{{ row.maxDownloads ? `${row.downloadCount}/${row.maxDownloads}` : `${row.downloadCount}/不限` }}</span>
                <span v-if="row.previewOnly" class="muted">仅预览</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="过期时间" min-width="160">
            <template #default="{ row }">{{ formatTime(row.expiresAt) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="shareStatusMeta(row.status).type">{{ shareStatusMeta(row.status).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="250">
            <template #default="{ row }">
              <el-button link type="primary" @click="copyText(row.url)">复制分享页</el-button>
              <el-button link type="primary" @click="copyText(row.downloadUrl)">复制直链</el-button>
              <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button v-if="row.enabled" link type="danger" @click="disableShare(row)">停用</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pagination-row">
          <el-pagination
            v-model:current-page="pageResult.page"
            v-model:page-size="pageResult.pageSize"
            :page-sizes="[10, 20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            :total="pageResult.total"
            @change="reload"
          />
        </div>
      </div>
    </section>

    <el-dialog
      v-model="editVisible"
      title="编辑分享"
      width="720px"
      align-center
      destroy-on-close
      append-to-body
    >
      <div class="edit-panel">
        <div v-if="editingShare" class="edit-banner">
          <div class="edit-file-name">{{ editingShare.fileName }}</div>
          <div class="muted mono">{{ editingShare.url }}</div>
        </div>

        <el-form label-position="top" class="edit-form">
          <div class="edit-section">
            <div class="edit-section-title">基础设置</div>
            <div class="edit-grid">
              <el-form-item label="访问密码">
                <el-switch v-model="form.requiresPassword" active-text="需要密码" inactive-text="无需密码" />
                <el-input
                  v-if="form.requiresPassword"
                  v-model="form.password"
                  type="password"
                  show-password
                  autocomplete="off"
                  placeholder="留空则保持原密码"
                  class="form-input"
                />
              </el-form-item>
              <el-form-item label="过期时间">
                <el-date-picker
                  v-model="form.expiresAt"
                  type="datetime"
                  value-format="YYYY-MM-DDTHH:mm:ss[Z]"
                  placeholder="不限制"
                  class="full-input"
                />
              </el-form-item>
              <el-form-item label="下载次数">
                <el-switch v-model="form.limitDownloads" active-text="限制次数" inactive-text="不限次数" />
                <el-input-number
                  v-if="form.limitDownloads"
                  v-model="form.maxDownloads"
                  :min="1"
                  controls-position="right"
                  class="form-input"
                />
              </el-form-item>
              <el-form-item label="访问控制">
                <el-switch v-model="form.previewOnly" active-text="仅预览不可下载" inactive-text="允许下载" />
              </el-form-item>
              <el-form-item label="状态">
                <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
              </el-form-item>
            </div>
          </div>

          <div class="edit-section">
            <div class="edit-section-title">高级设置</div>
            <div class="edit-grid">
              <el-form-item label="自定义分享后缀" class="edit-span-2">
                <el-input
                  v-model="form.customPath"
                  maxlength="200"
                  show-word-limit
                  placeholder="例如 docs/readme → /s/docs/readme；清空则恢复默认随机链接"
                >
                  <template #prepend>/s/</template>
                </el-input>
                <div class="muted form-hint">字母数字、下划线、中划线与 /；全局唯一，重复会提示。</div>
              </el-form-item>
              <el-form-item label="图片水印文字">
                <el-input
                  v-model="form.watermarkText"
                  maxlength="64"
                  show-word-limit
                  placeholder="仅图片预览/下载生效，留空清除"
                />
              </el-form-item>
              <el-form-item label="访问 IP 白名单" class="edit-span-2">
                <el-input
                  v-model="form.allowedIpsText"
                  type="textarea"
                  :rows="2"
                  placeholder="每行或逗号分隔 IP / IPv4 CIDR，留空不限制"
                />
              </el-form-item>
            </div>
          </div>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitEdit">保存修改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { fileApi, projectApi } from '@/api/modules';
import type { PageResult, Project, ShareLink, ShareStatus } from '@/types';
import { copyText } from '@/utils/io';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const submitting = ref(false);
const editVisible = ref(false);
const projects = ref<Project[]>([]);
const editingShare = ref<ShareLink | null>(null);
const hadPassword = ref(false);
const filters = reactive({
  projectId: String(route.query.projectId || ''),
  keyword: '',
  status: '' as ShareStatus | '',
});
const form = reactive({
  requiresPassword: false,
  password: '',
  expiresAt: '',
  limitDownloads: false,
  maxDownloads: undefined as number | undefined,
  enabled: true,
  previewOnly: false,
  watermarkText: '',
  customPath: '',
  allowedIpsText: '',
});
const pageResult = reactive<PageResult<ShareLink>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

function shareStatusMeta(status: ShareStatus): { label: string; type: 'success' | 'info' | 'warning' | 'danger' } {
  const meta: Record<ShareStatus, { label: string; type: 'success' | 'info' | 'warning' | 'danger' }> = {
    ACTIVE: { label: '有效', type: 'success' },
    DISABLED: { label: '停用', type: 'info' },
    EXPIRED: { label: '已过期', type: 'warning' },
    EXHAUSTED: { label: '次数耗尽', type: 'danger' },
  };
  return meta[status];
}

function formatTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '不限制';
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseAllowedIps(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

function validateCustomPath(raw: string): boolean {
  const customPath = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!customPath) {
    return true;
  }
  if (customPath.length > 200) {
    ElMessage.warning('自定义分享后缀不能超过 200 个字符。');
    return false;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(customPath)) {
    ElMessage.warning('自定义分享后缀仅允许字母、数字、下划线、中划线与 /，且需以字母或数字开头。');
    return false;
  }
  return true;
}

async function loadProjects(): Promise<void> {
  projects.value = await projectApi.list();
}

function search(): void {
  pageResult.page = 1;
  void reload();
}

async function reload(): Promise<void> {
  void router.replace({ path: '/shares', query: filters.projectId ? { projectId: filters.projectId } : {} });
  loading.value = true;
  try {
    const result = await fileApi.listAllShares({
      projectId: filters.projectId,
      keyword: filters.keyword,
      status: filters.status,
      page: pageResult.page,
      pageSize: pageResult.pageSize,
    });
    pageResult.items = result.items;
    pageResult.total = result.total;
    pageResult.page = result.page;
    pageResult.pageSize = result.pageSize;
  } finally {
    loading.value = false;
  }
}

function openEdit(share: ShareLink): void {
  editingShare.value = share;
  hadPassword.value = share.hasPassword;
  form.requiresPassword = share.hasPassword;
  form.password = '';
  form.expiresAt = share.expiresAt ? `${new Date(share.expiresAt).toISOString().slice(0, 19)}Z` : '';
  form.limitDownloads = share.maxDownloads !== null && share.maxDownloads !== undefined;
  form.maxDownloads = share.maxDownloads ?? undefined;
  form.enabled = share.enabled;
  form.previewOnly = share.previewOnly;
  form.watermarkText = share.watermarkText ?? '';
  form.customPath = share.customPath ?? '';
  form.allowedIpsText = (share.allowedIps ?? []).join('\n');
  editVisible.value = true;
}

async function submitEdit(): Promise<void> {
  if (!editingShare.value) {
    return;
  }

  if (form.requiresPassword && !hadPassword.value && form.password.length < 8) {
    ElMessage.warning('请设置至少 8 位访问密码。');
    return;
  }
  if (form.requiresPassword && form.password && form.password.length < 8) {
    ElMessage.warning('新密码至少 8 位。');
    return;
  }
  if (form.limitDownloads && !form.maxDownloads) {
    ElMessage.warning('请填写下载次数限制。');
    return;
  }
  if (!validateCustomPath(form.customPath)) {
    return;
  }

  submitting.value = true;
  try {
    await fileApi.updateShare(editingShare.value.id, {
      clearPassword: !form.requiresPassword,
      password: form.requiresPassword && form.password ? form.password : undefined,
      expiresAt: form.expiresAt || null,
      maxDownloads: form.limitDownloads ? form.maxDownloads : null,
      enabled: form.enabled,
      previewOnly: form.previewOnly,
      watermarkText: form.watermarkText.trim(),
      customPath: form.customPath.trim(),
      allowedIps: parseAllowedIps(form.allowedIpsText),
    });
    editVisible.value = false;
    ElMessage.success('分享已更新。');
    await reload();
  } finally {
    submitting.value = false;
  }
}

async function disableShare(share: ShareLink): Promise<void> {
  await ElMessageBox.confirm('停用后该分享链接无法继续访问。', '停用分享', {
    type: 'warning',
    confirmButtonText: '停用',
    cancelButtonText: '取消',
  });
  await fileApi.disableShare(share.id);
  ElMessage.success('分享已停用。');
  await reload();
}

onMounted(async () => {
  await Promise.all([loadProjects(), reload()]);
});
</script>

<style scoped>
.data-table {
  margin-top: 14px;
}

.file-cell,
.link-cell {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.link-cell .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pagination-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.edit-panel {
  display: grid;
  gap: 14px;
}

.edit-banner {
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: #f8fafc;
}

.edit-file-name {
  font-weight: 600;
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.edit-form {
  display: grid;
  gap: 12px;
}

.edit-section {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: #ffffff;
}

.edit-section-title {
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 700;
  color: #334155;
}

.edit-grid {
  display: grid;
  gap: 4px 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.edit-span-2 {
  grid-column: 1 / -1;
}

.form-input,
.full-input {
  width: 100%;
  margin-top: 8px;
}

.form-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.4;
}

@media (max-width: 720px) {
  .edit-grid {
    grid-template-columns: 1fr;
  }
}
</style>
