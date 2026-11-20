<template>
  <el-dialog
    :model-value="modelValue"
    :title="`按项目同步到阿里云盘 · ${config?.name || '存储'}`"
    width="min(620px, calc(100vw - 24px))"
    class="project-sync-dialog"
    append-to-body
    destroy-on-close
    :close-on-click-modal="!submitting"
    :close-on-press-escape="!submitting"
    :show-close="!submitting"
    @update:model-value="close"
  >
    <p class="project-sync-help">把所选项目的文件补齐到云盘，按项目名称保存，并整理能确认归属的旧对象。</p>
    <p class="project-sync-help">可单选或多选已分配的项目，最多 20 个。提交后在后台继续同步，可在任务管理查看进度。</p>
    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="要同步的项目">
        <el-select
          v-model="selected"
          aria-label="要同步的项目"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :max-collapse-tags="3"
          :multiple-limit="20"
          :loading="loading"
          :disabled="loading || submitting"
          placeholder="选择一个或多个项目"
          class="project-sync-select"
        >
          <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
        </el-select>
      </el-form-item>
    </el-form>
    <p v-if="!loading && !projects.length && !error" class="project-sync-help" role="status">暂无可同步的启用项目，请先在存储配置中分配项目。</p>
    <div v-if="error" class="project-sync-error" role="alert">
      <span>{{ error }}</span>
      <el-button v-if="!projects.length" :loading="loading" @click="loadProjects">重试</el-button>
    </div>
    <section v-if="result" class="project-sync-result" aria-live="polite">
      <p>已为 {{ result.queuedProjects }} 个项目提交同步任务。</p>
      <ul>
        <li v-for="project in result.projects" :key="project.projectId">
          <strong>{{ project.projectName }}</strong>
          <span>已排队<span v-if="project.requeued">，{{ project.requeued }} 个已有副本将重新整理</span></span>
        </li>
      </ul>
      <router-link to="/tasks" @click="close(false)">查看同步任务</router-link>
    </section>
    <template #footer>
      <div class="project-sync-footer">
        <span>已选 {{ selected.length }} / 20 个项目</span>
        <div>
          <el-button :disabled="submitting" @click="close(false)">关闭</el-button>
          <el-button type="primary" :loading="submitting" :disabled="loading || !selected.length || submitting" @click="submit">上传并按项目整理</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

import { projectApi } from '@/api/modules';
import { syncProjectsToStorage, type StorageProjectSyncResult } from '@/api/storage-project-sync';
import type { Project } from '@/types';

const props = defineProps<{ modelValue: boolean; config: { id: string; name: string; projects?: Array<{ id: string }> } | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const projects = ref<Project[]>([]), selected = ref<string[]>([]);
const loading = ref(false), submitting = ref(false), error = ref('');
const result = ref<StorageProjectSyncResult | null>(null);
let generation = 0, controller: globalThis.AbortController | undefined;

function close(value: boolean): void { if (!submitting.value) emit('update:modelValue', value); }
function message(reason: unknown, fallback: string): string {
  const value = (reason as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof value === 'string' ? value : fallback;
}
async function loadProjects(): Promise<void> {
  controller?.abort();
  controller = new globalThis.AbortController();
  const version = generation, signal = controller.signal;
  const current = () => props.modelValue && version === generation && !signal.aborted;
  loading.value = true;
  error.value = '';
  try {
    const rows = await projectApi.list(undefined, { signal, _silent: true });
    if (!current()) return;
    const assigned = new Set(props.config?.projects?.map(project => project.id) || []);
    projects.value = rows.filter(project => project.enabled && project.canManage && assigned.has(project.id));
  } catch (reason) {
    if (current()) error.value = message(reason, '项目列表读取失败，请重试。');
  } finally { if (current()) loading.value = false; }
}
async function submit(): Promise<void> {
  if (!props.config || !selected.value.length || submitting.value || loading.value) return;
  const version = generation, configId = props.config.id;
  submitting.value = true;
  error.value = '';
  result.value = null;
  try {
    const response = await syncProjectsToStorage(configId, selected.value);
    if (version !== generation) return;
    result.value = response;
    selected.value = [];
  } catch (reason) {
    if (version === generation) error.value = message(reason, '同步任务提交失败，请检查项目分配和存储连接后重试。');
  } finally { if (version === generation) submitting.value = false; }
}
watch(() => [props.modelValue, props.config?.id], () => {
  generation++;
  controller?.abort();
  projects.value = [];
  selected.value = [];
  error.value = '';
  result.value = null;
  loading.value = false;
  submitting.value = false;
  if (props.modelValue && props.config) void loadProjects();
}, { immediate: true });
onBeforeUnmount(() => { generation++; controller?.abort(); });
</script>

<style scoped>
:global(.el-dialog.project-sync-dialog) { max-height: calc(100dvh - 32px); margin-block: 16px; display: flex; flex-direction: column; }
:global(.project-sync-dialog .el-dialog__body) { overflow: auto; min-height: 0; }
.project-sync-help { margin-block: 0 14px; color: var(--color-text-secondary); line-height: 1.65; }
.project-sync-select { width: 100%; }
.project-sync-error { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-block: 16px; color: var(--color-text); }
.project-sync-result { margin-block: 18px 0; }
.project-sync-result ul { padding-inline-start: 20px; }
.project-sync-result li { margin-block: 10px; overflow-wrap: anywhere; }
.project-sync-result li > strong, .project-sync-result li > span { display: block; }
.project-sync-result li > span { color: var(--color-text-secondary); font-size: 13px; margin-block-start: 4px; }
.project-sync-result a { color: var(--color-primary-strong); text-underline-offset: 3px; }
.project-sync-footer, .project-sync-footer > div { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.project-sync-footer { justify-content: space-between; font-size: 13px; }
.project-sync-footer .el-button + .el-button { margin-inline-start: 0; }
</style>
