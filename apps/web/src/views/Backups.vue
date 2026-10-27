<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">备份管理</h1>
        <p class="page-subtitle">
          全量备份项目、文件、分享、存储配置等数据；可选把本地存储的文件内容一起打包。
        </p>
      </div>
      <div class="header-actions">
        <el-button :icon="Upload" :loading="importing" @click="triggerImport">导入备份文件</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreateDialog">新建备份</el-button>
      </div>
      <input ref="fileInput" type="file" accept=".gz,application/gzip" class="hidden-input" @change="handleImport" />
    </div>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar">
          <el-button :icon="Refresh" :loading="loading" @click="reload">刷新</el-button>
          <span class="muted">
            备份文件保存在服务器 BACKUP_ROOT 目录，可下载到本地留存。
          </span>
        </div>

        <el-table v-loading="loading" :data="backups" row-key="id" class="data-table">
          <el-table-column prop="name" label="备份名称" min-width="200" show-overflow-tooltip />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)">{{ statusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="120">
            <template #default="{ row }">{{ formatBytes(row.fileSize) }}</template>
          </el-table-column>
          <el-table-column label="含文件内容" width="120">
            <template #default="{ row }">
              <el-tag :type="row.includeObjects ? 'success' : 'info'" size="small">
                {{ row.includeObjects ? `是（${row.objectCount}）` : '否' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="备份范围" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ scopeSummary(row.scopes) }}</template>
          </el-table-column>
          <el-table-column label="数据表" width="100">
            <template #default="{ row }">{{ tableTotal(row) }} 行</template>
          </el-table-column>
          <el-table-column label="创建时间" width="180">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="说明" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.message" class="muted">{{ row.message }}</span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="250">
            <template #default="{ row }">
              <div class="table-actions">
                <el-button
                  link
                  type="primary"
                  :disabled="row.status !== 'SUCCEEDED' || !row.fileAvailable"
                  @click="downloadBackup(row)"
                >
                  下载
                </el-button>
                <el-button
                  link
                  type="primary"
                  :disabled="row.status !== 'SUCCEEDED' || !row.fileAvailable"
                  @click="openRestoreDialog(row)"
                >
                  恢复
                </el-button>
                <el-button link type="danger" @click="removeBackup(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <el-dialog v-model="createVisible" title="新建全量备份" width="560px">
      <el-form label-position="top">
        <el-form-item label="备份名称">
          <el-input v-model="createForm.name" maxlength="128" placeholder="留空按时间自动命名" />
        </el-form-item>
        <el-form-item label="备份内容（不选=全部）">
          <div class="scope-toolbar">
            <el-button link type="primary" @click="selectAllScopes(true)">全选</el-button>
            <el-button link type="primary" @click="selectAllScopes(false)">清空</el-button>
          </div>
          <el-checkbox-group v-model="createForm.scopes" class="scope-group">
            <el-checkbox v-for="scope in scopeOptions" :key="scope.key" :value="scope.key" class="scope-item">
              <span class="scope-label">{{ scope.label }}</span>
              <span class="scope-desc">{{ scope.description }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <div class="field-help">只备份勾选的内容，恢复时也只会恢复勾选的内容。</div>
        </el-form-item>
        <el-form-item label="包含本地文件内容">
          <el-switch v-model="createForm.includeObjects" :disabled="!createForm.scopes.includes('projects')" />
          <div class="field-help">
            勾选后会把 LOCAL 存储的文件一起打包（受 BACKUP_MAX_OBJECT_BYTES 限制，超出部分仅提示不打包）。
            云端存储对象不会被复制，恢复时按 cdnConfigId + storageKey 重新引用。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">开始备份</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="restoreVisible" title="从备份恢复" width="560px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="恢复会写入当前数据库，请先确认已另行留存现场数据。"
        style="margin-bottom: 12px"
      />
      <el-form label-position="top">
        <el-form-item label="恢复内容">
          <el-checkbox-group v-model="restoreForm.scopes" class="scope-group">
            <el-checkbox
              v-for="scope in restoreScopeOptions"
              :key="scope.key"
              :value="scope.key"
              class="scope-item"
            >
              <span class="scope-label">{{ scope.label }}</span>
              <span class="scope-desc">{{ scope.description }}</span>
            </el-checkbox>
          </el-checkbox-group>
          <div class="field-help">只能恢复该备份里已经包含的内容；不勾选则恢复全部。</div>
        </el-form-item>
        <el-form-item label="恢复模式">
          <el-radio-group v-model="restoreForm.mode">
            <el-radio value="merge">merge（仅补齐缺失记录）</el-radio>
            <el-radio value="replace">replace（先清空业务数据再恢复）</el-radio>
          </el-radio-group>
          <div class="field-help">
            merge 不会删除现有数据，遇到相同主键会跳过；replace 会先清空项目、文件、分享、存储配置等业务表
            （保留用户、审计日志、统计与备份记录），再按备份恢复。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="restoreVisible = false">取消</el-button>
        <el-button type="primary" :loading="restoring" @click="submitRestore">开始恢复</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Refresh, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';

import { backupApi, type BackupRecord, type BackupScopeInfo, type BackupStatus } from '@/api/modules';

const loading = ref(false);
const creating = ref(false);
const restoring = ref(false);
const backups = ref<BackupRecord[]>([]);
const createVisible = ref(false);
const restoreVisible = ref(false);
const restoreTarget = ref<BackupRecord | null>(null);
const importing = ref(false);
const fileInput = ref<HTMLInputElement>();
const scopeOptions = ref<BackupScopeInfo[]>([]);
const createForm = reactive<{ name: string; includeObjects: boolean; scopes: string[] }>({
  name: '',
  includeObjects: false,
  scopes: [],
});
const restoreForm = reactive<{ mode: 'merge' | 'replace'; scopes: string[] }>({
  mode: 'merge',
  scopes: [],
});

const restoreScopeOptions = computed(() => {
  const available = new Set(restoreTarget.value?.scopes ?? []);
  return scopeOptions.value.filter((scope) => available.has(scope.key));
});

function scopeLabel(key: string): string {
  return scopeOptions.value.find((scope) => scope.key === key)?.label ?? key;
}

function scopeSummary(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) {
    return '全部内容';
  }
  return scopes.map((key) => scopeLabel(key)).join('、');
}

function selectAllScopes(all: boolean): void {
  createForm.scopes = all ? scopeOptions.value.map((scope) => scope.key) : [];
}

async function loadScopes(): Promise<void> {
  scopeOptions.value = await backupApi.scopes();
}

function triggerImport(): void {
  fileInput.value?.click();
}

async function handleImport(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) {
    return;
  }

  importing.value = true;
  try {
    await backupApi.importFile(file);
    ElMessage.success('备份文件已导入，可直接用于恢复。');
    await reload();
  } finally {
    importing.value = false;
  }
}

function statusLabel(status: BackupStatus): string {
  switch (status) {
    case 'SUCCEEDED':
      return '已完成';
    case 'FAILED':
      return '失败';
    case 'RUNNING':
      return '进行中';
    default:
      return '排队中';
  }
}

function statusTagType(status: BackupStatus): 'success' | 'danger' | 'warning' | 'info' {
  if (status === 'SUCCEEDED') {
    return 'success';
  }
  if (status === 'FAILED') {
    return 'danger';
  }
  return 'warning';
}

function formatBytes(value?: number | null): string {
  const size = Number(value) || 0;
  if (size <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}

function tableTotal(row: BackupRecord): number {
  return Object.values(row.tableCounts ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    backups.value = await backupApi.list();
  } finally {
    loading.value = false;
  }
}

function openCreateDialog(): void {
  createForm.name = '';
  createForm.includeObjects = false;
  createForm.scopes = scopeOptions.value.map((scope) => scope.key);
  createVisible.value = true;
}

async function submitCreate(): Promise<void> {
  creating.value = true;
  try {
    await backupApi.create({
      name: createForm.name.trim() || undefined,
      scopes: createForm.scopes.length > 0 ? createForm.scopes : undefined,
      includeObjects: createForm.includeObjects && createForm.scopes.includes('projects'),
    });
    ElMessage.success('备份已完成。');
    createVisible.value = false;
    await reload();
  } finally {
    creating.value = false;
  }
}

function downloadBackup(row: BackupRecord): void {
  window.open(backupApi.downloadUrl(row.id), '_blank');
}

function openRestoreDialog(row: BackupRecord): void {
  restoreTarget.value = row;
  restoreForm.mode = 'merge';
  restoreForm.scopes = [...(row.scopes ?? [])];
  restoreVisible.value = true;
}

async function submitRestore(): Promise<void> {
  const target = restoreTarget.value;
  if (!target) {
    return;
  }

  try {
    await ElMessageBox.confirm(
      `确认从「${target.name}」恢复？\n范围：${scopeSummary(restoreForm.scopes)}\n模式：${restoreForm.mode}`,
      '确认恢复',
      { type: 'warning', confirmButtonText: '开始恢复', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }

  restoring.value = true;
  try {
    const result = await backupApi.restore(
      target.id,
      restoreForm.mode,
      restoreForm.scopes.length > 0 ? restoreForm.scopes : undefined,
    );
    const restoredRows = Object.values(result.restored).reduce((sum, count) => sum + Number(count || 0), 0);
    if (result.failures.length > 0) {
      ElMessage.warning(`恢复完成：写入 ${restoredRows} 行，${result.failures.length} 项失败。`);
    } else {
      ElMessage.success(`恢复完成：写入 ${restoredRows} 行，恢复文件对象 ${result.objectsRestored} 个。`);
    }
    restoreVisible.value = false;
    await reload();
  } finally {
    restoring.value = false;
  }
}

async function removeBackup(row: BackupRecord): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除备份「${row.name}」？备份文件会一并删除。`, '删除备份', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }

  await backupApi.remove(row.id);
  ElMessage.success('备份已删除。');
  await reload();
}

onMounted(async () => {
  await loadScopes().catch(() => undefined);
  await reload();
});
</script>

<style scoped>
.data-table {
  margin-top: 14px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.hidden-input {
  display: none;
}

.scope-toolbar {
  width: 100%;
  display: flex;
  gap: 8px;
}

.scope-group {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.scope-item {
  height: auto;
  align-items: flex-start;
  margin-right: 0;
}

.scope-item :deep(.el-checkbox__label) {
  display: flex;
  flex-direction: column;
  line-height: 1.4;
}

.scope-label {
  font-weight: 500;
}

.scope-desc {
  color: var(--color-text-muted);
  font-size: 12px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.field-help {
  width: 100%;
  margin-top: 6px;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.6;
}
</style>
