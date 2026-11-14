<template>
  <el-dialog :model-value="modelValue" title="文件详情" width="min(960px, calc(100vw - 24px))" append-to-body destroy-on-close @update:model-value="$emit('update:modelValue', $event)">
    <div v-loading="loading && !snapshot" class="file-details">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-descriptions v-if="currentFile" :column="1" border class="metadata">
        <el-descriptions-item label="文件名">{{ currentFile.originalName }}</el-descriptions-item>
        <el-descriptions-item label="项目">{{ currentFile.projectName || currentFile.projectId }}</el-descriptions-item>
        <el-descriptions-item label="目录">{{ currentFile.folderPath || '/' }}</el-descriptions-item>
        <el-descriptions-item label="大小／版本">{{ formatSize(currentFile.size) }} · v{{ currentFile.currentVersion || 1 }}</el-descriptions-item>
        <el-descriptions-item label="SHA256"><span class="checksum">{{ currentFile.checksum || '尚无摘要' }}</span></el-descriptions-item>
        <el-descriptions-item label="文件直链"><div class="direct-link"><el-input :model-value="directUrl" readonly /><el-button :disabled="!directUrl" @click="copyLink">复制</el-button></div></el-descriptions-item>
      </el-descriptions>
      <el-alert v-if="snapshot" :title="preferredDownloadLabel(snapshot.items)" type="info" :closable="false" show-icon>
        <p>下载顺序：{{ downloadOrderLabel(snapshot.items) || '暂无启用存储' }}</p>
        <p>按云存储优先级依次读取；云端失败、达到配额阈值或没有可用云副本时才使用本地。下方状态表示副本同步情况，实际来源以本次下载结果为准。</p>
      </el-alert>
      <div class="section-head"><div><strong>存储副本</strong><p class="muted">当前版本的原文件；上传先保存本地安全副本，云存储在后台同步。状态为最近一次记录。</p></div><el-button :loading="loading" @click="refresh">刷新状态</el-button></div>
      <el-checkbox-group v-model="selected">
        <el-table :data="snapshot?.items || []" row-key="configId" empty-text="暂无副本信息">
          <el-table-column v-if="snapshot?.canManage && currentFile?.status === 'ACTIVE'" label="选择" width="64"><template #default="{ row }"><el-checkbox :value="row.configId" :disabled="!canSyncReplica(row) || syncing" :aria-label="`同步到${row.configName}`" /></template></el-table-column>
          <el-table-column label="存储" min-width="160"><template #default="{ row }"><strong>{{ row.configName }}</strong><div class="muted">{{ row.provider }} · {{ row.desired ? '当前目标' : '已有位置' }}</div></template></el-table-column>
          <el-table-column label="状态" min-width="145"><template #default="{ row }"><el-tag :type="replicaTagType(row)">{{ replicaLabel(row) }}</el-tag></template></el-table-column>
          <el-table-column label="下载用途" min-width="125"><template #default="{ row }">{{ !row.enabled || (!row.assigned && !row.desired) ? '不参与下载' : row.provider === 'LOCAL' ? '本地兜底' : `云端优先级 ${row.priority}` }}</template></el-table-column>
          <el-table-column label="最近校验" min-width="170"><template #default="{ row }">{{ row.verifiedAt ? new Date(row.verifiedAt).toLocaleString() : '尚未校验' }}</template></el-table-column>
          <el-table-column prop="lastError" label="失败原因" min-width="170" show-overflow-tooltip />
        </el-table>
      </el-checkbox-group>
      <div v-if="snapshot?.canManage && currentFile?.status === 'ACTIVE'" class="sync-actions"><el-button :disabled="!syncCandidates.length || syncing" @click="selected = syncCandidates.map(item => item.configId)">选择缺失副本</el-button><el-button type="primary" :loading="syncing" :disabled="!selected.length || loading" @click="syncSelected">同步缺失副本</el-button></div>
      <p v-if="snapshot" class="muted">状态读取时间：{{ new Date(snapshot.updatedAt).toLocaleString() }}。新增存储绑定此项目后也会自动补齐；已校验的副本无需重复上传。</p>
    </div>
    <template #footer><el-button @click="$emit('update:modelValue', false)">关闭</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { fileStorageApi } from '@/api/file-storage';
import type { FileReplicaDetail, ManagedFile } from '@/types';
import { canSyncReplica, downloadOrderLabel, preferredDownloadLabel, hasPendingReplicas, replicaLabel, replicaSnapshotMatches, replicaTagType, shouldAcceptReplicaSnapshot } from '@/utils/storage-replica-view';
import { copyText } from '@/utils/io';

const props = defineProps<{ modelValue: boolean; file: ManagedFile | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; changed: [snapshot: FileReplicaDetail, file: ManagedFile] }>();
const currentFile = ref<ManagedFile | null>(null), snapshot = ref<FileReplicaDetail | null>(null);
const loading = ref(false), syncing = ref(false), error = ref(''), selected = ref<string[]>([]);
const syncCandidates = computed(() => (snapshot.value?.items || []).filter(canSyncReplica));
const directUrl = computed(() => {
  const url = currentFile.value?.publicUrl || currentFile.value?.accessUrl;
  return url ? new URL(url, window.location.origin).toString() : '';
});
let generation = 0, contextGeneration = 0, controller: globalThis.AbortController | undefined, timer: ReturnType<typeof globalThis.setTimeout> | undefined;
function stop(): void { generation++; controller?.abort(); globalThis.clearTimeout(timer); timer = undefined; }
function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
async function copyLink(): Promise<void> {
  try { await copyText(directUrl.value); ElMessage.success('完整文件直链已复制。'); }
  catch { ElMessage.error('复制失败，可从直链输入框手动复制。'); }
}
async function refresh(): Promise<void> {
  if (!props.modelValue || !props.file) return;
  stop();
  const read = ++generation, fileId = props.file.id;
  controller = new globalThis.AbortController();
  const signal = controller.signal;
  const current = () => read === generation && props.modelValue && props.file?.id === fileId && !signal.aborted;
  loading.value = true;
  try {
    const [file, result] = await Promise.all([fileStorageApi.file(fileId, { signal, _silent: true }), fileStorageApi.detail(fileId, { signal, _silent: true })]);
    if (!current()) return;
    if (!replicaSnapshotMatches(file, result)) throw new Error('文件版本刚刚更新，请刷新状态。');
    if (!shouldAcceptReplicaSnapshot(file, result, snapshot.value)) return;
    currentFile.value = file; snapshot.value = result; error.value = '';
    const eligible = new Set(result.items.filter(canSyncReplica).map(item => item.configId));
    selected.value = selected.value.filter(id => eligible.has(id));
    emit('changed', result, file);
  } catch (reason) {
    if (current()) error.value = reason instanceof Error && reason.message === '文件版本刚刚更新，请刷新状态。' ? reason.message : '副本信息加载失败，已知状态仍保留，请刷新重试。';
  } finally {
    if (current()) {
      loading.value = false;
      if (error.value || hasPendingReplicas(snapshot.value?.items || [])) timer = globalThis.setTimeout(() => { void refresh(); }, 3000);
    }
  }
}
async function syncSelected(): Promise<void> {
  const file = currentFile.value;
  if (!file || !snapshot.value?.canManage || syncing.value) return;
  const valid = new Set(syncCandidates.value.map(item => item.configId)), ids = selected.value.filter(id => valid.has(id));
  if (!ids.length) return;
  const context = contextGeneration;
  const current = () => context === contextGeneration && props.modelValue && props.file?.id === file.id;
  globalThis.clearTimeout(timer);
  syncing.value = true; error.value = '';
  try {
    const result = await fileStorageApi.sync(file.id, ids);
    if (!current()) return;
    selected.value = [];
    ElMessage.success(result.queued ? `已安排 ${result.queued} 份副本同步，可在此查看状态。` : '副本已有任务或已上传，无需重复同步。');
    await refresh();
  } catch {
    if (current()) error.value = '同步未提交成功，请检查存储绑定、文件状态和连接后重试。';
  } finally { if (current()) syncing.value = false; }
}
watch(() => [props.modelValue, props.file?.id, props.file?.projectId], () => {
  contextGeneration++;
  stop(); snapshot.value = null; currentFile.value = props.file; selected.value = []; error.value = ''; loading.value = false; syncing.value = false;
  if (props.modelValue && props.file) void refresh();
}, { immediate: true });
onBeforeUnmount(() => { contextGeneration++; stop(); });
</script>

<style scoped>
.metadata { margin: 14px 0 22px; }
.checksum { overflow-wrap: anywhere; font-family: monospace; }
.direct-link, .section-head, .sync-actions { display: flex; align-items: center; gap: 12px; }
.section-head { justify-content: space-between; margin-bottom: 12px; }
.section-head p, .file-details > p { font-size: 12px; line-height: 1.7; }
.sync-actions { margin-top: 16px; flex-wrap: wrap; }
@media (max-width: 600px) { .section-head, .direct-link { align-items: stretch; flex-direction: column; } }
</style>
