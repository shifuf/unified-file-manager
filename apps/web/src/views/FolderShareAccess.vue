<template>
  <main class="share-page" :style="pageStyle">
    <section class="share-panel" :style="panelStyle">
      <div v-if="hasBrandHeader" class="brand-block">
        <img v-if="brand.logoUrl" class="brand-logo" :src="brand.logoUrl" alt="" />
        <div>
          <div v-if="brand.title" class="brand-title" :style="{ color: brand.primaryColor }">{{ brand.title }}</div>
          <div v-if="brand.subtitle" class="brand-subtitle">{{ brand.subtitle }}</div>
        </div>
      </div>

      <div class="share-header">
        <div>
          <h1 class="share-title">{{ info?.projectName || '目录分享' }}</h1>
          <p class="share-subtitle">目录 {{ info?.folderPath || '/' }}</p>
        </div>
      </div>

      <el-form v-if="info?.hasPassword" label-position="top" @submit.prevent="loadFiles">
        <el-form-item label="分享密码">
          <el-input v-model="password" type="password" show-password placeholder="请输入分享密码" />
        </el-form-item>
        <el-button type="primary" :loading="loading" :style="primaryButtonStyle" @click="loadFiles">打开目录</el-button>
      </el-form>

      <div v-loading="loading" class="file-list">
        <div v-for="file in files" :key="file.id" class="file-row">
          <div>
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
        <el-empty v-if="!loading && files.length === 0" description="目录为空或尚未解锁" />
      </div>

      <footer v-if="brand.footerText || brand.showPoweredBy" class="share-footer">
        <div v-if="brand.footerText">{{ brand.footerText }}</div>
        <div v-if="brand.showPoweredBy" class="powered-by">由统一文件管理提供</div>
      </footer>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { http } from '@/api/http';
import type { SharePageBrand } from '@/types';
import { saveBlob } from '@/utils/io';

const DEFAULT_BRAND: SharePageBrand = {
  title: '',
  subtitle: '',
  logoUrl: '',
  primaryColor: '#2563eb',
  background: '#f8fafc',
  panelBackground: '#ffffff',
  footerText: '',
  showPoweredBy: true,
};

const route = useRoute();
const token = computed(() => String(route.params.token || ''));
const password = ref('');
const loading = ref(false);
const downloadingId = ref('');
const info = ref<{
  projectName?: string;
  folderPath?: string;
  hasPassword?: boolean;
  previewOnly?: boolean;
  brand?: SharePageBrand;
} | null>(null);
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
const hasBrandHeader = computed(() => Boolean(brand.value.title || brand.value.subtitle || brand.value.logoUrl));
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
  info.value = await http.get(`/folder-shares/${token.value}`);
  if (!info.value?.hasPassword) {
    await loadFiles();
  }
}

async function loadFiles(): Promise<void> {
  loading.value = true;
  try {
    const result = (await http.post(`/folder-shares/${token.value}/files`, {
      password: password.value || undefined,
      page: 1,
      pageSize: 100,
    })) as { items?: Array<{ id: string; originalName: string; size: number; folderPath?: string }> };
    files.value = result.items || [];
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

async function downloadFile(file: { id: string; originalName: string }): Promise<void> {
  downloadingId.value = file.id;
  try {
    const blob = (await http.post(
      `/folder-shares/${token.value}/files/${file.id}/download`,
      { password: password.value || undefined },
      { responseType: 'blob', timeout: 0 },
    )) as unknown as Blob;
    saveBlob(blob, file.originalName);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '下载失败');
  } finally {
    downloadingId.value = '';
  }
}

onMounted(() => {
  void loadInfo();
});
</script>

<style scoped>
.share-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}
.share-panel {
  width: min(720px, 100%);
  border-radius: 16px;
  padding: 24px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
}
.brand-block {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #e2e8f0;
}
.brand-logo {
  width: 40px;
  height: 40px;
  object-fit: contain;
  border-radius: 8px;
  background: #f8fafc;
}
.brand-title {
  font-size: 16px;
  font-weight: 700;
}
.brand-subtitle {
  margin-top: 2px;
  color: #64748b;
  font-size: 13px;
}
.share-title {
  margin: 0;
  font-size: 22px;
}
.share-subtitle {
  margin: 6px 0 0;
  color: #64748b;
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
</style>
