<template>
  <el-dialog
    :model-value="modelValue"
    :title="`云盘文件 · ${config?.name || '存储'}`"
    width="min(1040px, calc(100vw - 24px))"
    class="remote-files-dialog"
    append-to-body
    destroy-on-close
    :show-close="!importing"
    :close-on-click-modal="!importing"
    :close-on-press-escape="!importing"
    @update:model-value="closeDialog"
  >
    <div class="remote-files-content">
      <p class="remote-help">选择文件或文件夹，同步到1–20个项目；文件夹和当前目录会包含所有子目录。每次最多2000个文件，保留相对目录。</p>
      <p class="remote-help">系统备份导入只添加到备份列表，不会自动恢复数据。</p>

      <div class="remote-toolbar">
        <nav class="remote-breadcrumbs" aria-label="云盘目录">
          <template v-for="(crumb, index) in breadcrumbs" :key="`${index}:${crumb.id}`">
            <span v-if="index" class="remote-crumb-divider" aria-hidden="true">/</span>
            <button
              type="button"
              :disabled="index === breadcrumbs.length - 1 || loading || importing || hasPendingJob"
              :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined"
              @click="openBreadcrumb(index)"
            >{{ crumb.name }}</button>
          </template>
        </nav>
        <div class="remote-toolbar-actions">
          <el-button :disabled="breadcrumbs.length < 2 || loading || importing || hasPendingJob" @click="openBreadcrumb(breadcrumbs.length - 2)">返回上级目录</el-button>
          <el-button :loading="loading" :disabled="importing || hasPendingJob" @click="refreshList">刷新列表</el-button>
        </div>
      </div>

      <div class="remote-import-options">
        <div>
          <label for="remote-target-project">目标项目</label>
          <el-select
            id="remote-target-project"
            v-model="projectIds"
            aria-label="目标项目"
            placeholder="选择1–20个目标项目"
            :loading="projectsLoading"
            :disabled="importing || hasPendingJob || projectsLoading"
            filterable
            multiple
            :multiple-limit="20"
            collapse-tags
            collapse-tags-tooltip
            @change="clearRetry"
          >
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
        </div>
        <div>
          <label for="remote-target-folder">目标目录</label>
          <el-input id="remote-target-folder" v-model="folderPath" aria-label="目标目录" placeholder="留空放入项目根目录" :disabled="importing || hasPendingJob" @input="clearRetry" />
        </div>
      </div>
      <div v-if="projectError" class="remote-inline-error" role="alert">
        <span>{{ projectError }}</span>
        <el-button size="small" :loading="projectsLoading" :disabled="importing" @click="loadProjects">重试项目</el-button>
      </div>
      <p v-else-if="!projectsLoading && !projects.length" class="remote-help">暂无可管理的启用项目；仍可下载文件或导入系统备份。</p>
      <p v-else-if="!projectIds.length" class="remote-help">先选择目标项目，再同步所选内容或当前目录。</p>

      <div class="remote-selection-toolbar">
        <el-checkbox
          :model-value="allSelected"
          :indeterminate="selectedIds.length > 0 && !allSelected"
          :disabled="!items.length || loading || importing || hasPendingJob || Boolean(listError)"
          aria-label="全选当前页"
          @change="selectPage(Boolean($event))"
        >全选当前页</el-checkbox>
        <el-button :disabled="!loaded || loading || importing || hasPendingJob || !projectIds.length || Boolean(listError)" @click="syncDirectory">同步当前目录</el-button>
      </div>

      <div v-if="listError" class="remote-inline-error" role="alert">
        <span>{{ listError }}</span>
        <el-button size="small" :disabled="importing" @click="retryList">重试列表</el-button>
      </div>
      <div v-loading="loading" class="remote-list-content" :aria-busy="loading">
        <p v-if="loaded && !loading && !listError && !items.length" class="remote-empty" role="status">此目录暂无文件。</p>
        <ul class="remote-file-list" aria-label="云盘文件">
          <li v-for="item in items" :key="item.id" class="remote-file-row">
            <div class="remote-file-choice">
              <el-checkbox
                :model-value="selectedIds.includes(item.id)"
                :disabled="importing || hasPendingJob || loading || Boolean(listError)"
                :aria-label="`选择 ${displayName(item)}`"
                @change="toggleSelection(item.id, Boolean($event))"
              />
            </div>
            <div class="remote-file-info">
              <div class="remote-file-heading">
                <el-icon aria-hidden="true"><Folder v-if="item.type === 'folder'" /><Document v-else /></el-icon>
                <button v-if="item.type === 'folder'" type="button" class="remote-file-name remote-folder-name" :aria-label="`打开文件夹 ${displayName(item)}`" :disabled="loading || importing || hasPendingJob" @click="openFolder(item)">{{ displayName(item) }}</button>
                <strong v-else class="remote-file-name">{{ displayName(item) }}</strong>
              </div>
              <p v-if="unresolvedName(item)" class="remote-name-help">未获取到原文件名，显示云端名称。</p>
              <p v-if="item.project" class="remote-project-identity">所属项目：{{ item.project.name }}（{{ item.project.id }}）</p>
              <div class="remote-file-meta">
                <span>{{ item.type === 'folder' ? '文件夹' : formatSize(item.size) }}</span>
                <time v-if="item.updatedAt" :datetime="item.updatedAt">{{ formatTime(item.updatedAt) }}</time>
              </div>
            </div>
            <div v-if="item.type === 'file'" class="remote-file-actions">
              <a
                v-if="readyDownloads[item.id] && !importing && !hasPendingJob"
                class="remote-download"
                :href="readyDownloads[item.id].url"
                target="_blank"
                rel="noopener noreferrer"
                @click="delete readyDownloads[item.id]"
              >保存已校验文件</a>
              <el-button v-else link :loading="downloadingId === item.id" :disabled="importing || hasPendingJob || loading || Boolean(listError)" @click="prepareDownload(item.id)">下载</el-button>
              <el-button link :disabled="importing || hasPendingJob || loading || Boolean(listError)" @click="importBackup(item.id)">作为系统备份导入</el-button>
            </div>
          </li>
        </ul>
      </div>
      <div v-if="nextCursor && !listError" class="remote-more">
        <el-button :loading="loading" :disabled="importing || hasPendingJob" @click="loadMore">加载更多</el-button>
      </div>

      <div v-if="importing" class="remote-import-progress" role="status" aria-live="polite">
        <template v-if="downloadingId">
          <p>正在后台取回并校验下载文件，完成后可保存到本地。</p>
          <progress aria-label="正在准备已校验下载" />
        </template>
        <template v-else-if="discovering">
          <p>正在完整读取所选内容：已发现 {{ discoveredFiles }} 个文件、{{ discoveredDirectories }} 个目录；读取完成后开始同步。</p>
          <progress aria-label="正在读取云盘目录" />
        </template>
        <template v-else>
          <p>{{ importingBackup ? '正在取回系统备份并校验内容…' : `同步进度：完成 ${completedCount} / ${totalCount} 项（文件 × 项目）。` }}</p>
          <progress aria-label="云盘同步进度" :value="completedCount" :max="Math.max(1, totalCount)" />
        </template>
      </div>
      <p v-if="syncNotice" class="remote-help" role="status">{{ syncNotice }}</p>
      <p v-if="importError" class="remote-inline-error" role="alert">{{ importError }}</p>
      <div v-if="canRetry" class="remote-retry-actions">
        <el-button :disabled="importing || loading" @click="retrySync">重试未完成项</el-button>
        <span class="remote-help">{{ retryDescription }}</span>
      </div>
      <section v-if="importResult" class="remote-import-result" aria-label="导入结果" aria-live="polite">
        <h3>{{ importSummary }}</h3>
        <ul>
          <li v-for="item in importResult.items" :key="`${item.id}:${item.projectId || 'backup'}`">
            <strong>{{ item.name }}</strong>
            <span v-if="item.projectId" class="remote-result-project" :title="item.projectId">{{ item.projectName || item.projectId }}</span>
            <span :class="item.status === 'FAILED' ? 'remote-result-failed' : 'remote-result-success'">{{ item.status === 'IMPORTED' ? '已导入' : '失败' }}</span>
            <p v-if="item.error">{{ item.error }}</p>
          </li>
        </ul>
      </section>
    </div>
    <template #footer>
      <div class="remote-footer">
        <span role="status">已选择 {{ selectedFileCount }} 个文件、{{ selectedFolderCount }} 个文件夹 · {{ projectIds.length }} 个目标项目</span>
        <div>
          <el-button :disabled="importing" @click="closeDialog(false)">关闭</el-button>
          <el-button type="primary" :loading="importing && !importingBackup && !downloadingId" :disabled="!selectedIds.length || !projectIds.length || loading || importing || hasPendingJob || Boolean(listError)" @click="syncSelection">同步所选</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { Document, Folder } from '@element-plus/icons-vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { projectApi } from '@/api/modules';
import { RemoteJobPendingError, remoteFilesApi, type StorageRemoteFile, type StorageRemoteImportResult } from '@/api/remote-files';
import type { Project } from '@/types';
import { collectRemoteSyncFiles, createRemoteSyncBatches, refreshRemoteSyncBatch, type RemoteSyncBatch } from '@/utils/remote-sync';

const props = defineProps<{ modelValue: boolean; config: { id: string; name: string } | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
interface Breadcrumb { id: string; name: string }
interface ListRead { parentId?: string; append?: boolean; trail?: Breadcrumb[] }
interface DiscoveryPlan { entries?: StorageRemoteFile[]; parentId?: string; folderPath: string; projectIds: string[]; selectionIds?: string[]; itemCursors?: ReadonlyMap<string, string | undefined> }
type ImportItem = StorageRemoteImportResult['items'][number];

const items = ref<StorageRemoteFile[]>([]);
const breadcrumbs = ref<Breadcrumb[]>([{ id: '', name: '根目录' }]);
const parentId = ref('');
const nextCursor = ref<string | null>(null);
const selectedIds = ref<string[]>([]);
const loading = ref(false), loaded = ref(false), listError = ref('');
const projects = ref<Project[]>([]), projectIds = ref<string[]>([]), folderPath = ref('');
const projectsLoading = ref(false), projectError = ref('');
const importing = ref(false), importingBackup = ref(false), discovering = ref(false);
const discoveredFiles = ref(0), discoveredDirectories = ref(0), totalCount = ref(0);
const importError = ref(''), importResult = ref<StorageRemoteImportResult | null>(null);
const syncNotice = ref(''), discoveryRetry = ref<DiscoveryPlan | null>(null), pendingBatches = ref<RemoteSyncBatch[]>([]), backupRetry = ref('');
const backupJobId = ref(''), downloadingId = ref('');
const downloadRetry = ref<{ id: string; jobId?: string } | null>(null);
const readyDownloads = ref<Record<string, { url: string; name: string; size: number }>>({});
let operationSelectionIds: string[] | undefined;
let lifecycle = 0, readVersion = 0;
let listController: globalThis.AbortController | undefined;
let projectsController: globalThis.AbortController | undefined;
let transferController: globalThis.AbortController | undefined;
let lastRead: ListRead = {};
let readCursors = new Set<string>();
let itemCursors = new Map<string, string | undefined>();

const allSelected = computed(() => items.value.length > 0 && items.value.every(item => selectedIds.value.includes(item.id)));
const selectedFileCount = computed(() => items.value.filter(item => item.type === 'file' && selectedIds.value.includes(item.id)).length);
const selectedFolderCount = computed(() => items.value.filter(item => item.type === 'folder' && selectedIds.value.includes(item.id)).length);
const completedCount = computed(() => importResult.value?.items.length || 0);
const hasPendingJob = computed(() => Boolean(backupJobId.value || downloadRetry.value?.jobId || pendingBatches.value.some(batch => batch.jobId)));
const canRetry = computed(() => !importing.value && Boolean(discoveryRetry.value || pendingBatches.value.length || backupRetry.value || downloadRetry.value));
const retryDescription = computed(() => hasPendingJob.value ? '继续查询已提交的后台任务，不会重复提交。' : discoveryRetry.value ? '将重新完整读取目录；尚未导入任何文件。' : '仅重试失败或尚未完成的文件与目标项目。');

const importSummary = computed(() => {
  if (!importResult.value) return '';
  const { imported, failed } = importResult.value;
  if (importingBackup.value) return `已导入 ${imported} 份系统备份${failed ? `，${failed} 个失败` : ''}。`;
  return `已同步 ${imported} 项（文件 × 项目）${failed ? `，${failed} 项失败` : ''}。`;
});

function displayName(item: StorageRemoteFile): string { return item.originalName || item.name; }
function unresolvedName(item: StorageRemoteFile): boolean {
  return item.type === 'file' && !item.originalName && /^[a-f0-9]{64}(?:[._-].*)?$/i.test(item.name);
}
function formatSize(value: number | string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}
function errorMessage(reason: unknown, fallback: string): string {
  const data = (reason as { response?: { data?: { message?: unknown } } } | null)?.response?.data;
  if (typeof data?.message === 'string') return data.message;
  if (Array.isArray(data?.message) && data.message.every((message) => typeof message === 'string')) return data.message.join('；');
  if (reason instanceof Error && !('isAxiosError' in reason)) return reason.message;
  return fallback;
}
function clearRetry(): void {
  if (importing.value || hasPendingJob.value) return;
  discoveryRetry.value = null;
  pendingBatches.value = [];
  backupRetry.value = '';
  backupJobId.value = '';
  downloadRetry.value = null;
}
function toggleSelection(id: string, checked: boolean): void {
  if (importing.value || hasPendingJob.value || loading.value) return;
  clearRetry();
  if (!checked) selectedIds.value = selectedIds.value.filter((selected) => selected !== id);
  else if (!selectedIds.value.includes(id)) selectedIds.value.push(id);
}
function selectPage(checked: boolean): void {
  if (importing.value || hasPendingJob.value || loading.value) return;
  clearRetry();
  selectedIds.value = checked ? items.value.map(item => item.id) : [];
}
function closeDialog(value: boolean): void {
  if (!importing.value) emit('update:modelValue', value);
}
async function loadProjects(): Promise<void> {
  projectsController?.abort();
  projectsController = new globalThis.AbortController();
  const signal = projectsController.signal, context = lifecycle;
  const current = () => props.modelValue && context === lifecycle && !signal.aborted;
  projectsLoading.value = true;
  projectError.value = '';
  try {
    const result = await projectApi.list(undefined, { signal, _silent: true });
    if (current()) {
      projects.value = result.filter((project) => project.enabled && project.canManage);
      projectIds.value = projectIds.value.filter(id => projects.value.some(project => project.id === id));
    }
  } catch (reason) {
    if (current()) projectError.value = errorMessage(reason, '项目列表读取失败，请重试。');
  } finally {
    if (current()) projectsLoading.value = false;
  }
}
async function loadDirectory(read: ListRead = {}): Promise<void> {
  const configId = props.config?.id;
  if (!props.modelValue || !configId || importing.value || hasPendingJob.value) return;
  const cursor = read.append ? nextCursor.value : undefined;
  if (read.append && !cursor) return;
  listController?.abort();
  listController = new globalThis.AbortController();
  const signal = listController.signal, version = ++readVersion, context = lifecycle;
  const current = () => props.modelValue && props.config?.id === configId && context === lifecycle && version === readVersion && !signal.aborted;
  lastRead = read;
  loading.value = true;
  listError.value = '';
  try {
    const result = await remoteFilesApi.list(configId, { parentId: read.parentId, cursor: cursor || undefined }, { signal, _silent: true });
    if (!current()) return;
    if (read.append) {
      if (result.parentId !== parentId.value) throw new Error('读取时云盘目录发生变化，请刷新后重试。');
      if (result.nextCursor && (result.nextCursor === cursor || readCursors.has(result.nextCursor))) throw new Error('云盘分页标记重复，请刷新后重试。');
      items.value = [...new Map([...items.value, ...result.items].map((item) => [item.id, item])).values()];
      if (cursor) readCursors.add(cursor);
    } else {
      items.value = result.items;
      selectedIds.value = [];
      clearRetry();
      readCursors = new Set<string>();
      itemCursors = new Map<string, string | undefined>();
      breadcrumbs.value = (read.trail || [{ id: result.parentId, name: '根目录' }]).map((crumb, index, trail) => index === trail.length - 1 ? { ...crumb, id: result.parentId } : crumb);
    }
    for (const item of result.items) itemCursors.set(item.id, cursor || undefined);
    parentId.value = result.parentId;
    nextCursor.value = result.nextCursor;
    loaded.value = true;
  } catch (reason) {
    if (current()) listError.value = errorMessage(reason, '云盘目录读取失败，请重试；已有列表仍保留。');
  } finally {
    if (current()) loading.value = false;
  }
}
function refreshList(): void { void loadDirectory({ parentId: parentId.value || undefined, trail: breadcrumbs.value }); }
function retryList(): void { void loadDirectory(lastRead); }
function loadMore(): void { void loadDirectory({ parentId: parentId.value, append: true }); }
function openFolder(item: StorageRemoteFile): void {
  void loadDirectory({ parentId: item.id, trail: [...breadcrumbs.value, { id: item.id, name: displayName(item) }] });
}
function openBreadcrumb(index: number): void {
  const crumb = breadcrumbs.value[index];
  if (!crumb || index >= breadcrumbs.value.length - 1) return;
  void loadDirectory({ parentId: crumb.id, trail: breadcrumbs.value.slice(0, index + 1) });
}
function mergeResults(incoming: ImportItem[]): void {
  const merged = new Map((importResult.value?.items || []).map(item => [`${item.id}:${item.projectId || 'backup'}`, item]));
  for (const item of incoming) merged.set(`${item.id}:${item.projectId || 'backup'}`, item);
  const resultItems = [...merged.values()];
  importResult.value = { imported: resultItems.filter(item => item.status === 'IMPORTED').length, failed: resultItems.filter(item => item.status === 'FAILED').length, items: resultItems };
}
function normalizeResults(batch: RemoteSyncBatch, result: StorageRemoteImportResult): ImportItem[] {
  return batch.files.flatMap(file => batch.projectIds.map(projectId => {
    const item = result.items.find(item => item.id === file.id && (item.projectId === projectId || !item.projectId && batch.projectIds.length === 1));
    return {
      id: file.id,
      name: item?.name || file.name,
      projectId,
      projectName: item?.projectName || projects.value.find(project => project.id === projectId)?.name || projectId,
      status: item?.status === 'IMPORTED' ? 'IMPORTED' : 'FAILED',
      ...(item?.fileId ? { fileId: item.fileId } : {}),
      ...(item?.error ? { error: item.error } : !item ? { error: '云盘返回的同步结果不完整，请重试未完成项。' } : {}),
    };
  }));
}
function failedBatches(batch: RemoteSyncBatch, resultItems: ImportItem[]): RemoteSyncBatch[] {
  const groups = new Map<string, RemoteSyncBatch>();
  for (const file of batch.files) {
    const failed = batch.projectIds.filter(projectId => resultItems.some(item => item.id === file.id && item.projectId === projectId && item.status === 'FAILED'));
    if (!failed.length) continue;
    const key = JSON.stringify(failed);
    const group = groups.get(key) || { files: [], projectIds: failed, folderPath: batch.folderPath };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()];
}
async function runBatches(batches: RemoteSyncBatch[], configId: string, current: () => boolean): Promise<void> {
  const retry: RemoteSyncBatch[] = [];
  pendingBatches.value = [];
  for (const [index, batch] of batches.entries()) {
    if (!current()) return;
    try {
      if (!batch.jobId) await refreshRemoteSyncBatch(batch, query => remoteFilesApi.list(configId, query, { signal: transferController?.signal, _silent: true }));
      if (!current()) return;
      const result = await remoteFilesApi.import(configId, {
        projectIds: batch.projectIds,
        fileIds: batch.files.map(file => file.id),
        ...(batch.folderPath ? { folderPath: batch.folderPath } : {}),
      }, { signal: transferController?.signal, jobId: batch.jobId, onJob: id => { if (current()) batch.jobId = id; } });
      if (!current()) return;
      const resultItems = normalizeResults(batch, result);
      mergeResults(resultItems);
      retry.push(...failedBatches(batch, resultItems));
    } catch (reason) {
      if (!current()) return;
      if (!(reason instanceof RemoteJobPendingError)) batch.jobId = undefined;
      importError.value = errorMessage(reason, '文件同步失败，请确认连接与文件状态后重试。');
      retry.push(...batches.slice(index));
      break;
    }
  }
  if (!current()) return;
  pendingBatches.value = retry;
  if (operationSelectionIds) {
    const remaining = new Set(retry.flatMap(batch => batch.files.map(file => file.selectionId).filter(Boolean)));
    selectedIds.value = selectedIds.value.filter(id => !operationSelectionIds!.includes(id) || remaining.has(id));
  }
}
function available(): boolean {
  return Boolean(props.config?.id && !importing.value && !hasPendingJob.value && !loading.value && !listError.value && projectIds.value.length && !projectsLoading.value && !projectError.value);
}
function syncSelection(): void {
  if (!available()) return;
  const entries = items.value.filter(item => selectedIds.value.includes(item.id));
  if (!entries.length) return;
  void discoverAndSync({ entries, folderPath: folderPath.value, projectIds: [...projectIds.value], selectionIds: [...selectedIds.value], itemCursors: new Map(itemCursors) });
}
function syncDirectory(): void {
  if (!available()) return;
  void discoverAndSync({ parentId: parentId.value || undefined, folderPath: folderPath.value, projectIds: [...projectIds.value] });
}
async function discoverAndSync(plan: DiscoveryPlan): Promise<void> {
  const configId = props.config?.id;
  if (!configId || importing.value) return;
  const context = lifecycle;
  const current = () => props.modelValue && props.config?.id === configId && context === lifecycle;
  transferController?.abort();
  transferController = new globalThis.AbortController();
  importing.value = true;
  importingBackup.value = false;
  discovering.value = true;
  discoveredFiles.value = 0;
  discoveredDirectories.value = 0;
  totalCount.value = 0;
  importError.value = '';
  importResult.value = null;
  syncNotice.value = '';
  discoveryRetry.value = plan;
  pendingBatches.value = [];
  backupRetry.value = '';
  backupJobId.value = '';
  downloadRetry.value = null;
  operationSelectionIds = plan.selectionIds;
  try {
    const files = await collectRemoteSyncFiles({
      ...plan,
      list: async query => {
        if (!current()) throw new Error('同步已结束。');
        return remoteFilesApi.list(configId, query, { signal: transferController?.signal, _silent: true });
      },
      onProgress: (fileCount, directoryCount) => {
        if (!current()) return;
        discoveredFiles.value = fileCount;
        discoveredDirectories.value = directoryCount;
      },
    });
    if (!current()) return;
    discoveryRetry.value = null;
    discovering.value = false;
    if (!files.length) {
      syncNotice.value = plan.entries ? '所选目录中没有可同步的文件。' : '当前目录及子目录没有可同步的文件。';
      return;
    }
    totalCount.value = files.length * plan.projectIds.length;
    await runBatches(createRemoteSyncBatches(files, plan.projectIds), configId, current);
  } catch (reason) {
    if (current()) importError.value = errorMessage(reason, '云盘目录读取失败；尚未导入任何文件，请重试。');
  } finally {
    if (current()) { importing.value = false; discovering.value = false; }
  }
}
async function retrySync(): Promise<void> {
  if (importing.value || loading.value) return;
  if (discoveryRetry.value) { await discoverAndSync(discoveryRetry.value); return; }
  if (backupRetry.value) { await importBackup(backupRetry.value, backupJobId.value || undefined); return; }
  if (downloadRetry.value) { await prepareDownload(downloadRetry.value.id, downloadRetry.value.jobId); return; }
  const configId = props.config?.id;
  if (!configId || !pendingBatches.value.length) return;
  const context = lifecycle;
  const current = () => props.modelValue && props.config?.id === configId && context === lifecycle;
  transferController?.abort();
  transferController = new globalThis.AbortController();
  importing.value = true;
  importError.value = '';
  try { await runBatches([...pendingBatches.value], configId, current); }
  finally { if (current()) importing.value = false; }
}
async function importBackup(id: string, jobId?: string): Promise<void> {
  const configId = props.config?.id;
  if (!configId || importing.value || loading.value || listError.value || hasPendingJob.value && !jobId) return;
  const context = lifecycle;
  const current = () => props.modelValue && props.config?.id === configId && context === lifecycle;
  transferController?.abort();
  transferController = new globalThis.AbortController();
  importing.value = true;
  importingBackup.value = true;
  discovering.value = false;
  importError.value = '';
  importResult.value = null;
  syncNotice.value = '';
  totalCount.value = 1;
  discoveryRetry.value = null;
  pendingBatches.value = [];
  backupRetry.value = id;
  backupJobId.value = jobId || '';
  downloadRetry.value = null;
  try {
    if (!jobId) await refreshSingleFile(id, configId);
    if (!current()) return;
    const result = await remoteFilesApi.import(configId, { fileIds: [id], asBackup: true }, { signal: transferController.signal, jobId, onJob: id => { if (current()) backupJobId.value = id; } });
    if (!current()) return;
    importResult.value = result;
    backupJobId.value = '';
    if (!result.failed) backupRetry.value = '';
  } catch (reason) {
    if (current()) {
      if (!(reason instanceof RemoteJobPendingError)) backupJobId.value = '';
      importError.value = errorMessage(reason, '系统备份导入失败，请重试。');
    }
  } finally {
    if (current()) importing.value = false;
  }
}
async function refreshSingleFile(id: string, configId: string): Promise<void> {
  const item = items.value.find(item => item.id === id && item.type === 'file');
  if (!item) throw new Error('云盘文件不在当前列表中，请刷新列表后重试。');
  const list = (query: { parentId?: string; cursor?: string }) => remoteFilesApi.list(configId, query, { signal: transferController?.signal, _silent: true });
  const files = await collectRemoteSyncFiles({ entries: [item], itemCursors, list });
  await refreshRemoteSyncBatch({ files, projectIds: [], folderPath: '' }, list);
}
async function prepareDownload(id: string, jobId?: string): Promise<void> {
  const configId = props.config?.id;
  if (!configId || importing.value || loading.value || listError.value || hasPendingJob.value && !jobId) return;
  const context = lifecycle;
  const current = () => props.modelValue && props.config?.id === configId && context === lifecycle;
  transferController?.abort();
  transferController = new globalThis.AbortController();
  importing.value = true;
  importingBackup.value = false;
  discovering.value = false;
  downloadingId.value = id;
  importError.value = '';
  importResult.value = null;
  syncNotice.value = '';
  discoveryRetry.value = null;
  pendingBatches.value = [];
  backupRetry.value = '';
  backupJobId.value = '';
  downloadRetry.value = { id, jobId };
  try {
    if (!jobId) await refreshSingleFile(id, configId);
    if (!current()) return;
    const download = await remoteFilesApi.prepareDownload(configId, id, { signal: transferController.signal, jobId, onJob: jobId => { if (current()) downloadRetry.value = { id, jobId }; } });
    if (!current()) return;
    readyDownloads.value[id] = download;
    downloadRetry.value = null;
    syncNotice.value = '文件已校验，点击“保存已校验文件”下载；链接10分钟内有效，仅可使用一次。';
  } catch (reason) {
    if (current()) {
      if (!(reason instanceof RemoteJobPendingError)) downloadRetry.value = { id };
      importError.value = errorMessage(reason, '下载准备失败，请重试。');
    }
  } finally {
    if (current()) { importing.value = false; downloadingId.value = ''; }
  }
}
watch(() => [props.modelValue, props.config?.id], () => {
  lifecycle++;
  readVersion++;
  listController?.abort();
  projectsController?.abort();
  transferController?.abort();
  items.value = [];
  breadcrumbs.value = [{ id: '', name: '根目录' }];
  parentId.value = '';
  nextCursor.value = null;
  selectedIds.value = [];
  projects.value = [];
  projectIds.value = [];
  folderPath.value = '';
  listError.value = '';
  projectError.value = '';
  importError.value = '';
  importResult.value = null;
  syncNotice.value = '';
  discoveryRetry.value = null;
  pendingBatches.value = [];
  backupRetry.value = '';
  backupJobId.value = '';
  downloadRetry.value = null;
  readyDownloads.value = {};
  downloadingId.value = '';
  operationSelectionIds = undefined;
  readCursors = new Set<string>();
  itemCursors = new Map<string, string | undefined>();
  loading.value = false;
  loaded.value = false;
  importing.value = false;
  discovering.value = false;
  if (props.modelValue && props.config) {
    void loadDirectory();
    void loadProjects();
  }
}, { immediate: true });
onBeforeUnmount(() => {
  lifecycle++;
  listController?.abort();
  projectsController?.abort();
  transferController?.abort();
});
</script>

<style scoped>
:global(.el-dialog.remote-files-dialog) {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 32px);
  margin-block: 16px;
}

:global(.remote-files-dialog .el-dialog__header),
:global(.remote-files-dialog .el-dialog__footer) {
  flex: none;
}

:global(.remote-files-dialog .el-dialog__body) {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.remote-files-content { container: remote-files / inline-size; min-width: 0; }
.remote-help { margin: 0 0 8px; color: var(--color-text-secondary); font-size: 13px; line-height: 1.65; }
.remote-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-block: 18px; }
.remote-breadcrumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.remote-breadcrumbs button { border: 0; padding: 4px; background: transparent; color: var(--color-primary-strong); font: inherit; cursor: pointer; overflow-wrap: anywhere; }
.remote-breadcrumbs button[aria-current] { color: var(--color-text); cursor: default; }
.remote-crumb-divider { color: var(--color-text-secondary); }
.remote-toolbar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.remote-toolbar-actions .el-button + .el-button { margin-inline-start: 0; }
.remote-import-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-block-end: 16px; }
.remote-import-options label { display: block; margin-block-end: 6px; font-size: 13px; }
.remote-import-options .el-select { width: 100%; }
.remote-import-options > div { min-width: 0; }
.remote-selection-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-block: 16px; }
.remote-inline-error { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-block: 14px; padding: 12px; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text); overflow-wrap: anywhere; }
.remote-list-content { min-height: 90px; }
.remote-empty { padding-block: 30px; color: var(--color-text-secondary); text-align: center; }
.remote-file-list { margin: 0; padding: 0; list-style: none; }
.remote-file-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding-block: 14px; border-block-end: 1px solid var(--color-border); }
.remote-file-info { min-width: 0; }
.remote-file-heading { display: flex; align-items: flex-start; gap: 7px; }
.remote-file-heading .el-icon { flex: none; margin-block-start: 4px; color: var(--color-text-secondary); }
.remote-file-name { display: block; min-width: 0; font-size: 14px; font-weight: 600; line-height: 1.65; text-align: start; overflow-wrap: anywhere; white-space: normal; }
.remote-folder-name { border: 0; padding: 0; background: transparent; color: var(--color-primary-strong); cursor: pointer; }
.remote-name-help { margin: 4px 0; color: var(--color-text-secondary); font-size: 12px; line-height: 1.6; }
.remote-project-identity { margin: 5px 0; font-size: 12px; line-height: 1.6; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.remote-file-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-block-start: 5px; color: var(--color-text-secondary); font-size: 12px; line-height: 1.6; }
.remote-file-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 16px; }
.remote-download { padding-block: 4px; color: var(--color-primary-strong); font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
.remote-download-disabled { padding-block: 4px; color: var(--color-text-secondary); font-size: 13px; }
.remote-file-actions .el-button { margin: 0; white-space: normal; }
.remote-more { display: flex; justify-content: center; margin-block: 16px; }
.remote-import-progress { margin-block: 18px; font-size: 13px; }
.remote-import-progress progress { width: 100%; height: 8px; accent-color: var(--color-primary-strong); }
.remote-retry-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-block: 16px; }
.remote-retry-actions .remote-help { margin: 0; }
.remote-import-result { margin-block-start: 20px; }
.remote-import-result h3 { margin-block: 0 10px; font-size: 14px; }
.remote-import-result ul { margin: 0; padding: 0; list-style: none; }
.remote-import-result li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; padding-block: 10px; border-block-end: 1px solid var(--color-border); overflow-wrap: anywhere; }
.remote-import-result li strong { min-width: 0; flex: 1 1 180px; font-size: 13px; }
.remote-result-project { color: var(--color-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.remote-import-result li p { flex-basis: 100%; margin: 0; font-size: 13px; line-height: 1.6; }
.remote-result-failed { color: #b42318; font-size: 12px; }
.remote-result-success { color: #067647; font-size: 12px; }
.remote-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.remote-footer > div { display: flex; flex-wrap: wrap; gap: 8px; }
.remote-footer .el-button + .el-button { margin-inline-start: 0; }

@container remote-files (max-width: 40rem) {
  .remote-file-row { grid-template-columns: 24px minmax(0, 1fr); }
  .remote-file-actions { grid-column: 2 / -1; justify-content: flex-start; }
}

@container remote-files (max-width: 26rem) {
  .remote-import-options { grid-template-columns: minmax(0, 1fr); }
}
</style>
