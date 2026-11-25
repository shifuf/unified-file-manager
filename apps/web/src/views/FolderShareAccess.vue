<template>
  <main class="share-page" :style="pageStyle">
    <ShareBrandHeader :brand="brand" :site-name="siteName" />
    <div class="share-content">
    <section class="share-panel" :style="panelStyle">
      <SharePageState v-if="initialLoading" loading />
      <SharePageState v-else-if="loadError" :error="loadError" @retry="loadInfo" />
      <template v-else-if="info">
      <div class="share-header">
        <div>
          <h1 class="share-title">{{ info?.projectName || '目录分享' }}</h1>
          <p class="share-subtitle">目录 {{ info?.folderPath || '/' }}</p>
        </div>
      </div>

      <el-form v-if="info.hasPassword && !unlocked" label-position="top" class="password-form" @submit.prevent="loadFiles">
        <el-form-item label="分享密码">
          <el-input v-model="password" type="password" show-password autocomplete="off" placeholder="请输入分享密码" />
        </el-form-item>
        <p v-if="unlockError" class="unlock-error" role="alert">{{ unlockError }}</p>
        <el-button type="primary" :loading="loading" :style="primaryButtonStyle" @click="loadFiles">打开目录</el-button>
      </el-form>

      <SharePageState v-if="filesError" :error="filesError" @retry="loadFiles" />
      <p v-else-if="info.hasPassword && !unlocked" class="locked-state">输入分享密码后即可查看目录内容。</p>
      <div v-else v-loading="loading" class="file-list" :aria-busy="loading">
        <p v-if="loading" class="muted" role="status">正在加载目录内容…</p>
        <div v-for="file in files" :key="file.id" class="file-row">
          <div class="file-copy">
            <div class="file-name">{{ file.originalName }}</div>
            <div class="muted">{{ formatSize(file.size) }} · {{ file.folderPath }}</div>
          </div>
          <el-button
            v-if="!info?.previewOnly"
            type="primary"
            link
            :loading="downloadingId === file.id"
            :style="{ color: brand.primaryColor }"
            @click="downloadFile(file)"
          >
            下载
          </el-button>
        </div>
        <el-empty v-if="!loading && unlocked && files.length === 0" description="目录为空" />
      </div>
      </template>

      <footer v-if="brand.footerText || brand.showPoweredBy" class="share-footer">
        <div v-if="brand.footerText">{{ brand.footerText }}</div>
        <div v-if="brand.showPoweredBy" class="powered-by">由统一文件管理提供</div>
      </footer>
    </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { http } from '@/api/http';
import ShareBrandHeader from '@/components/ShareBrandHeader.vue';
import SharePageState from '@/components/SharePageState.vue';
import type { SharePageBrand } from '@/types';
import { saveBlob } from '@/utils/io';
import { DEFAULT_SHARE_BRAND as DEFAULT_BRAND, getPublicShareFailure, getShareSiteName, readPublicShareMessage } from '@/utils/public-share';
import type { PublicShareFailure } from '@/utils/public-share';

const route = useRoute();
const siteName = getShareSiteName();
const token = computed(() => String(route.params.token || ''));
const password = ref('');
const loading = ref(false);
const downloadingId = ref('');
const initialLoading = ref(true);
const unlocked = ref(false);
const loadError = ref<PublicShareFailure | null>(null);
const filesError = ref<PublicShareFailure | null>(null);
const unlockError = ref('');
let infoRequest = 0;
let filesRequest = 0;
let readController: globalThis.AbortController | undefined;
interface PublicFolderShareInfo {
  projectName?: string;
  folderPath?: string;
  hasPassword?: boolean;
  previewOnly?: boolean;
  brand?: SharePageBrand;
}
const info = ref<PublicFolderShareInfo | null>(null);
const files = ref<
  Array<{
    id: string;
    originalName: string;
    size: number;
    folderPath?: string;
  }>
>([]);

const brand = computed<SharePageBrand>(() => ({
  ...DEFAULT_BRAND,
  ...(info.value?.brand || {}),
}));
const pageStyle = computed(() => ({
  background: brand.value.background || DEFAULT_BRAND.background,
}));
const panelStyle = computed(() => ({
  background: brand.value.panelBackground || DEFAULT_BRAND.panelBackground,
}));
const primaryButtonStyle = computed(() => ({
  '--el-button-bg-color': brand.value.primaryColor,
  '--el-button-border-color': brand.value.primaryColor,
  '--el-button-hover-bg-color': brand.value.primaryColor,
  '--el-button-hover-border-color': brand.value.primaryColor,
}));

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function loadInfo(): Promise<void> {
  const request = ++infoRequest;
  ++filesRequest;
  readController?.abort();
  readController = new globalThis.AbortController();
  initialLoading.value = true;
  loading.value = false;
  loadError.value = null;
  filesError.value = null;
  unlockError.value = '';
  unlocked.value = false;
  password.value = '';
  info.value = null;
  files.value = [];
  downloadingId.value = '';
  try {
    if (!token.value) throw Object.assign(new Error('分享链接不可用'), { response: { status: 404 } });
    const result = await http.get<unknown, PublicFolderShareInfo>(`/folder-shares/${encodeURIComponent(token.value)}`, { _silent: true, signal: readController.signal });
    if (request !== infoRequest) return;
    info.value = result;
    initialLoading.value = false;
    if (!info.value?.hasPassword) await loadFiles();
  } catch (error) {
    if (request === infoRequest) loadError.value = getPublicShareFailure(error);
  } finally {
    if (request === infoRequest) initialLoading.value = false;
  }
}

async function loadFiles(): Promise<void> {
  if (!info.value || loading.value) return;
  if (info.value.hasPassword && !password.value) {
    unlockError.value = '请输入分享密码。';
    return;
  }
  const currentInfoRequest = infoRequest;
  const request = ++filesRequest;
  loading.value = true;
  filesError.value = null;
  unlockError.value = '';
  files.value = [];
  try {
    const result = (await http.post(`/folder-shares/${encodeURIComponent(token.value)}/files`, {
      password: password.value || undefined,
      page: 1,
      pageSize: 100,
    }, { _silent: true, signal: readController?.signal })) as { items?: Array<{ id: string; originalName: string; size: number; folderPath?: string }> };
    if (request !== filesRequest || currentInfoRequest !== infoRequest) return;
    files.value = result.items || [];
    unlocked.value = true;
  } catch (error) {
    if (request !== filesRequest || currentInfoRequest !== infoRequest) return;
    const failure = getPublicShareFailure(error);
    if (failure.kind === 'password') {
      unlocked.value = false;
      unlockError.value = '分享密码错误，请检查后重新输入。';
    } else if (failure.kind === 'unavailable' || failure.kind === 'restricted') {
      loadError.value = failure;
    } else {
      filesError.value = failure;
    }
  } finally {
    if (request === filesRequest && currentInfoRequest === infoRequest) loading.value = false;
  }
}

async function downloadFile(file: { id: string; originalName: string }): Promise<void> {
  const request = infoRequest;
  downloadingId.value = file.id;
  try {
    const blob = (await http.post(
      `/folder-shares/${token.value}/files/${file.id}/download`,
      { password: password.value || undefined },
      { responseType: 'blob', timeout: 0, _silent: true },
    )) as unknown as Blob;
    if (request === infoRequest) saveBlob(blob, file.originalName);
  } catch (error) {
    const message = await readPublicShareMessage(error, '下载暂时无法开始，请稍后重试。');
    if (request === infoRequest) ElMessage.error(message);
  } finally {
    if (request === infoRequest) downloadingId.value = '';
  }
}

onMounted(loadInfo);
watch(token, () => { void loadInfo(); });
onBeforeUnmount(() => {
  ++infoRequest;
  ++filesRequest;
  readController?.abort();
});
</script>

<style scoped>
.share-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.share-content {
  display: grid;
  place-items: center;
  flex: 1;
  width: 100%;
  padding: 40px 24px;
}
.share-panel {
  width: min(720px, 100%);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
}
.share-title {
  margin: 0;
  font-size: 22px;
  overflow-wrap: anywhere;
}
.share-subtitle {
  margin: 6px 0 0;
  color: #64748b;
  overflow-wrap: anywhere;
}
.password-form { margin-top: 24px; }
.unlock-error { margin: -4px 0 14px; color: #dc2626; font-size: 13px; line-height: 1.5; }
.locked-state { margin: 24px 0; color: #64748b; font-size: 14px; line-height: 1.6; }
.file-copy {
  min-width: 0;
  overflow-wrap: anywhere;
}
.file-list {
  margin-top: 18px;
}
.file-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid #e2e8f0;
}
.file-name {
  font-weight: 600;
}
.muted {
  color: #94a3b8;
  font-size: 12px;
}
.share-footer {
  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid #e2e8f0;
  color: #94a3b8;
  font-size: 12px;
  text-align: center;
  line-height: 1.5;
}
.powered-by {
  margin-top: 4px;
}
@media (max-width: 640px) {
  .share-content { padding: 24px 12px; }
  .share-panel { padding: 16px; }
}
</style>
