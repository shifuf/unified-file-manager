<template>
  <el-dialog
    :model-value="true" :title="`${editable ? '编辑内容' : '文本预览'} — ${file.originalName}`" width="85%"
    :before-close="beforeClose" :close-on-click-modal="false" :close-on-press-escape="!saving"
  >
    <div v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <p class="muted">UTF-8 · 最大 2 MiB · 当前版本 v{{ version }}。每次保存版本 +1，直链和分享链接保持不变。</p>
      <textarea
        v-model="content" class="text-editor" aria-label="文件内容" spellcheck="false"
        :readonly="!editable || loading || saving || !loaded"
      />
    </div>
    <template #footer>
      <el-button @click="copyDirectUrl">复制直链</el-button>
      <el-button :disabled="saving" @click="beforeClose">关闭</el-button>
      <el-button v-if="editable" type="primary" :loading="saving" :disabled="loading || !loaded" @click="save">保存新版本</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { fileApi } from '@/api/modules';
import type { ManagedFile } from '@/types';
import { copyText } from '@/utils/io';

const props = defineProps<{ file: ManagedFile; editable: boolean }>();
const emit = defineEmits<{ close: []; saved: [file: ManagedFile] }>();
const content = ref('');
const version = ref(props.file.currentVersion || 1);
const loading = ref(true);
const loaded = ref(false);
const saving = ref(false);
const error = ref('');
let original = '';
let originalText = '';
let active = true;
let bom = '';
let lineEnding = '\n';

onMounted(async () => {
  try {
    const result = await fileApi.getTextContent(props.file.id);
    if (!active) return;
    originalText = result.content;
    bom = result.content.startsWith('\uFEFF') ? '\uFEFF' : '';
    lineEnding = result.content.includes('\r\n') ? '\r\n' : '\n';
    content.value = result.content.slice(bom.length).replace(/\r\n/g, '\n');
    original = content.value;
    version.value = result.version;
    loaded.value = true;
  } catch (e) {
    if (active) error.value = (e as { response?: { data?: { message?: string } } }).response?.data?.message || '读取内容失败。';
  } finally { if (active) loading.value = false; }
});
onBeforeUnmount(() => { active = false; });

async function beforeClose(): Promise<void> {
  if (saving.value) return;
  if (content.value !== original) {
    try { await ElMessageBox.confirm('内容尚未保存，确定放弃修改？', '未保存的内容', { type: 'warning' }); }
    catch { return; }
  }
  emit('close');
}
async function save(): Promise<void> {
  if (saving.value || !loaded.value) return;
  const text = content.value === original ? originalText : bom + content.value.replace(/\n/g, lineEnding);
  if (new globalThis.TextEncoder().encode(text).length > 2 * 1024 * 1024) {
    ElMessage.warning('在线编辑最大支持 2 MiB。'); return;
  }
  saving.value = true;
  error.value = '';
  try {
    const file = await fileApi.updateTextContent(props.file.id, { content: text, expectedVersion: version.value });
    if (!active) return;
    version.value = file.currentVersion || version.value + 1;
    original = content.value;
    originalText = text;
    emit('saved', file);
    ElMessage.success(`已保存为 v${version.value}，直链和分享链接保持不变。`);
  } catch (e) {
    if (active) error.value = (e as { response?: { data?: { message?: string } } }).response?.data?.message || '保存失败，内容已保留；若有版本冲突，请复制内容后重新打开文件。';
  } finally { if (active) saving.value = false; }
}
function copyDirectUrl(): void {
  void copyText(new URL(props.file.accessUrl || `/api/public/files/${props.file.id}`, window.location.origin).toString());
  ElMessage.success('直链已复制；外部直接访问请先公开文件，或使用签名链接。');
}
</script>

<style scoped>
.text-editor { width: 100%; height: 55vh; box-sizing: border-box; padding: 14px; resize: vertical; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-bg-color); color: var(--el-text-color-primary); font: 14px/1.6 Consolas, monospace; tab-size: 2; white-space: pre; }
</style>
