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
          <h1 class="share-title">{{ shareInfo?.fileName || '文件分享' }}</h1>
          <p class="share-subtitle">
            <span v-if="shareInfo">{{ formatSize(shareInfo.size) }} · {{ categoryLabel(shareInfo.category) }}</span>
            <span v-else>正在加载分享信息</span>
          </p>
        </div>
      </div>

      <el-form label-position="top" @submit.prevent="onPrimaryAction">
        <el-form-item v-if="shareInfo?.hasPassword" label="分享密码">
          <el-input
            v-model="password"
            type="password"
            show-password
            autocomplete="off"
            placeholder="请输入分享密码"
            @keyup.enter="unlockAndPreview"
          />
        </el-form-item>

        <div v-if="previewing && !hasPreviewContent" class="preview-frame preview-loading">
          <span class="muted">正在加载预览…</span>
        </div>

        <div v-else-if="shareInfo && isOfficeShare(shareInfo)" class="preview-frame office-fallback">
          <p>Office 文档暂不支持在线预览，请下载后打开。</p>
        </div>

        <div v-else-if="previewText !== null && shareInfo" class="preview-frame text-preview">
          <pre class="text-preview-body">{{ previewText || '（文件为空）' }}</pre>
        </div>

        <div v-else-if="previewUrl && shareInfo" class="preview-frame">
          <img
            v-if="isImageShare(shareInfo)"
            :src="previewUrl"
            :alt="shareInfo.fileName"
            @error="onMediaError"
          />
          <video
            v-else-if="shareInfo.category === 'VIDEO'"
            :src="previewUrl"
            controls
            preload="metadata"
            @error="onMediaError"
          />
          <audio
            v-else-if="shareInfo.category === 'AUDIO'"
            :src="previewUrl"
            controls
            @error="onMediaError"
          />
          <iframe
            v-else-if="isPdfShare(shareInfo)"
            :src="previewUrl"
            :title="shareInfo.fileName"
            sandbox="allow-same-origin"
            referrerpolicy="no-referrer"
          />
          <iframe
            v-else
            :src="previewUrl"
            :title="shareInfo.fileName"
            sandbox="allow-same-origin"
            referrerpolicy="no-referrer"
          />
        </div>

        <div v-else-if="previewError" class="preview-frame office-fallback">
          <p>{{ previewError }}</p>
          <el-button @click="previewShare">重试预览</el-button>
        </div>

        <div v-else-if="shareInfo?.hasPassword && !unlocked" class="preview-frame office-fallback">
          <p>输入分享密码后即可在线查看。</p>
        </div>

        <div class="share-actions">
          <!-- 有密码且尚未解锁：用「查看」触发预览；可预览类型解锁后不再显示「打开预览」 -->
          <el-button
            v-if="shareInfo?.hasPassword && !unlocked && shareInfo.previewable && !isOfficeShare(shareInfo)"
            type="primary"
            :loading="previewing"
            :disabled="!canSubmit"
            :style="primaryButtonStyle"
            @click="unlockAndPreview"
          >
            查看
          </el-button>
          <el-button
            v-if="!shareInfo?.previewOnly"
            :type="shareInfo?.hasPassword && !unlocked ? 'default' : 'primary'"
            :loading="downloading"
            :disabled="!canSubmit || (shareInfo?.hasPassword && !unlocked && !password)"
            :style="shareInfo?.hasPassword && !unlocked ? undefined : primaryButtonStyle"
            @click="downloadShare"
          >
            下载文件
          </el-button>
          <el-tag v-else-if="shareInfo?.previewOnly" type="info">该分享仅支持在线预览</el-tag>
        </div>
      </el-form>

      <footer v-if="brand.footerText || brand.showPoweredBy" class="share-footer">
        <div v-if="brand.footerText">{{ brand.footerText }}</div>
        <div v-if="brand.showPoweredBy" class="powered-by">由统一文件管理提供</div>
      </footer>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import type { AxiosError } from 'axios';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { publicShareApi } from '@/api/modules';
import type { FileCategory, PublicShareInfo, SharePageBrand } from '@/types';

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

const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'log',
  'json',
  'xml',
  'yaml',
  'yml',
  'ini',
  'conf',
  'cfg',
  'env',
  'sql',
  'sh',
  'bat',
  'ps1',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'vue',
]);

const route = useRoute();
const accessKey = computed(() => {
  if (route.name === 'share-access-custom') {
    const match = route.params.pathMatch;
    if (Array.isArray(match)) {
      return match.filter(Boolean).join('/');
    }
    return String(match || '').replace(/^\/+|\/+$/g, '');
  }
  return String(route.params.token || '');
});
const password = ref('');
const downloading = ref(false);
const previewing = ref(false);
const shareInfo = ref<PublicShareInfo | null>(null);
/** Opaque token used for download/preview APIs. */
const shareToken = ref('');
const previewUrl = ref('');
const previewText = ref<string | null>(null);
const previewError = ref('');
const unlocked = ref(false);
const canSubmit = computed(() => Boolean(shareToken.value && shareInfo.value));
const hasPreviewContent = computed(
  () => previewText.value !== null || Boolean(previewUrl.value),
);
const brand = computed<SharePageBrand>(() => ({
  ...DEFAULT_BRAND,
  ...(shareInfo.value?.brand || {}),
}));
const hasBrandHeader = computed(() => Boolean(brand.value.title || brand.value.subtitle || brand.value.logoUrl));
const pageStyle = computed(() => ({
  background: brand.value.background || DEFAULT_BRAND.background,
}));
const panelStyle = computed(() => ({
  background: brand.value.panelBackground || DEFAULT_BRAND.panelBackground,
  borderColor: 'transparent',
  boxShadow: '0 12px 40px rgba(15, 23, 42, 0.08)',
}));
const primaryButtonStyle = computed(() => ({
  '--el-button-bg-color': brand.value.primaryColor,
  '--el-button-border-color': brand.value.primaryColor,
  '--el-button-hover-bg-color': brand.value.primaryColor,
  '--el-button-hover-border-color': brand.value.primaryColor,
  '--el-button-active-bg-color': brand.value.primaryColor,
  '--el-button-active-border-color': brand.value.primaryColor,
}));

const categoryOptions: Array<{ label: string; value: FileCategory }> = [
  { label: '图片', value: 'IMAGE' },
  { label: '文档', value: 'DOCUMENT' },
  { label: '视频', value: 'VIDEO' },
  { label: '音频', value: 'AUDIO' },
  { label: '压缩包', value: 'ARCHIVE' },
  { label: '代码', value: 'CODE' },
  { label: '其他', value: 'OTHER' },
];

async function loadShareInfo(): Promise<void> {
  if (!accessKey.value) {
    return;
  }

  try {
    const info =
      route.name === 'share-access-custom' || accessKey.value.includes('/')
        ? await publicShareApi.resolve(accessKey.value)
        : await publicShareApi.get(accessKey.value);
    shareInfo.value = info;
    shareToken.value = info.token;
    // Passwordless shares auto-open preview for images/text/audio/video/PDF.
    if (info.previewable && !info.hasPassword && !isOfficeShare(info)) {
      unlocked.value = true;
      await previewShare();
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '分享链接不可用。');
  }
}

async function unlockAndPreview(): Promise<void> {
  if (!shareInfo.value?.hasPassword) {
    await previewShare();
    return;
  }
  if (!password.value) {
    ElMessage.warning('请输入分享密码。');
    return;
  }
  unlocked.value = true;
  await previewShare();
}

function onPrimaryAction(): void {
  if (shareInfo.value?.hasPassword && !unlocked.value) {
    void unlockAndPreview();
    return;
  }
  if (!shareInfo.value?.previewOnly) {
    void downloadShare();
  }
}

async function previewShare(): Promise<void> {
  if (!canSubmit.value || previewing.value) {
    return;
  }

  previewing.value = true;
  previewError.value = '';
  try {
    const blob = await publicShareApi.preview(shareToken.value, password.value || undefined);
    if (await looksLikeJsonError(blob)) {
      const message = await readBlobErrorMessage(blob);
      throw new Error(message || '预览失败。');
    }
    if (blob.size === 0 && (shareInfo.value?.size ?? 0) > 0) {
      throw new Error('预览内容为空，请稍后重试或直接下载。');
    }

    if (shareInfo.value && isTextShare(shareInfo.value)) {
      previewText.value = await blob.text();
      revokePreviewUrl();
      unlocked.value = true;
      return;
    }

    previewText.value = null;
    setPreviewBlob(blob, resolvePreviewMime(shareInfo.value));
    unlocked.value = true;
  } catch (error) {
    previewText.value = null;
    revokePreviewUrl();
    previewError.value = error instanceof Error ? error.message : '预览失败。';
    ElMessage.error(previewError.value);
  } finally {
    previewing.value = false;
  }
}

/**
 * Start a native browser download (streamed). Avoid axios blob + saveBlob for large files:
 * that path buffers the entire object in memory and feels "very slow" before the dialog appears.
 *
 * Always go through download-session first so 429/ban JSON errors surface as a popup
 * (iframe navigation cannot show API error bodies).
 */
async function downloadShare(): Promise<void> {
  if (!canSubmit.value || downloading.value) {
    return;
  }
  if (shareInfo.value?.hasPassword && !password.value) {
    ElMessage.warning('请输入分享密码后再下载。');
    return;
  }

  downloading.value = true;
  try {
    const session = await publicShareApi.createDownloadSession(
      shareToken.value,
      password.value || undefined,
    );
    triggerBrowserDownload(session.url, shareInfo.value?.fileName);
    ElMessage.success('已开始下载，可继续停留在本页。');
  } catch (error) {
    const msg = extractShareErrorMessage(error);
    if (isRateLimitOrBanMessage(msg)) {
      await ElMessageBox.alert(msg, '下载受限', {
        type: 'warning',
        confirmButtonText: '知道了',
        closeOnClickModal: true,
      }).catch(() => undefined);
    } else {
      ElMessage.error(msg || '下载失败。');
    }
  } finally {
    downloading.value = false;
  }
}

function isRateLimitOrBanMessage(message: string): boolean {
  return /过于频繁|临时限制|禁止下载|拉黑|封禁|分钟后再试|限流/.test(message);
}

function extractShareErrorMessage(error: unknown): string {
  const axiosError = error as AxiosError<{ message?: string | string[] }>;
  const data = axiosError?.response?.data;
  if (data && typeof data === 'object' && 'message' in data) {
    const message = data.message;
    if (Array.isArray(message)) {
      return message.filter(Boolean).join('；');
    }
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return '下载失败。';
}

/**
 * Start download without navigating away from the share page.
 * - Prefer a hidden iframe: even if the browser follows a redirect URL, only the iframe moves.
 * - Also fire an <a download> for same-origin attachment responses.
 */
function triggerBrowserDownload(url: string, filename?: string): void {
  const frameName = `ufm-dl-${Date.now()}`;
  const iframe = document.createElement('iframe');
  iframe.name = frameName;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px';
  document.body.appendChild(iframe);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = frameName;
  anchor.rel = 'noopener';
  if (filename) {
    // Helps same-origin responses stay as downloads instead of top-level navigation.
    anchor.setAttribute('download', filename);
  }
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  window.setTimeout(() => {
    iframe.remove();
  }, 180_000);
}

function setPreviewBlob(blob: globalThis.Blob, mimeType?: string): void {
  revokePreviewUrl();
  const type = mimeType || blob.type || 'application/octet-stream';
  const typed = blob.type === type ? blob : new Blob([blob], { type });
  previewUrl.value = URL.createObjectURL(typed);
}

function resolvePreviewMime(info: PublicShareInfo | null): string | undefined {
  if (!info) {
    return undefined;
  }
  if (info.mimeType) {
    return info.mimeType;
  }
  if (isImageShare(info)) {
    return 'image/png';
  }
  if (isPdfShare(info)) {
    return 'application/pdf';
  }
  return undefined;
}

async function looksLikeJsonError(blob: globalThis.Blob): Promise<boolean> {
  if (blob.type && blob.type.includes('json')) {
    return true;
  }
  // Small payloads that look like Nest error JSON.
  if (blob.size > 0 && blob.size < 4096) {
    try {
      const head = await blob.slice(0, 64).text();
      return head.trimStart().startsWith('{') && head.includes('statusCode');
    } catch {
      return false;
    }
  }
  return false;
}

async function readBlobErrorMessage(blob: globalThis.Blob): Promise<string> {
  try {
    const json = JSON.parse(await blob.text()) as { message?: string | string[] };
    if (Array.isArray(json.message)) {
      return json.message.join('；');
    }
    return json.message || '请求失败。';
  } catch {
    return '请求失败。';
  }
}

function onMediaError(): void {
  previewError.value = '媒体无法显示，请尝试下载查看。';
  revokePreviewUrl();
}

function isPdfShare(info: PublicShareInfo): boolean {
  return info.mimeType === 'application/pdf' || /\.pdf$/i.test(info.fileName || '');
}

function isImageShare(info: PublicShareInfo): boolean {
  if (info.category === 'IMAGE') {
    return true;
  }
  const mime = (info.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(info.fileName || '');
}

function isTextShare(info: PublicShareInfo): boolean {
  const mime = (info.mimeType || '').toLowerCase();
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime === 'application/javascript') {
    return true;
  }
  if (info.category === 'CODE') {
    return true;
  }
  const name = info.fileName || '';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return TEXT_PREVIEW_EXTENSIONS.has(ext);
}

function isOfficeShare(info: PublicShareInfo): boolean {
  const name = (info.fileName || '').toLowerCase();
  if (/\.(docx?|xlsx?|pptx?)$/i.test(name)) {
    return true;
  }
  const mime = (info.mimeType || '').toLowerCase();
  return (
    mime.includes('officedocument') ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.ms-powerpoint'
  );
}

function revokePreviewUrl(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = '';
  }
}

function formatSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function categoryLabel(category: FileCategory): string {
  return categoryOptions.find((item) => item.value === category)?.label || category;
}

onMounted(loadShareInfo);
onBeforeUnmount(revokePreviewUrl);
</script>

<style scoped>
.share-page {
  display: grid;
  min-height: 100vh;
  padding: 24px;
  place-items: center;
}

.share-panel {
  width: min(760px, 100%);
  padding: 24px;
  border-radius: 16px;
}

.brand-block {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  padding-bottom: 14px;
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
  line-height: 1.3;
}

.brand-subtitle {
  margin-top: 2px;
  color: #64748b;
  font-size: 13px;
  line-height: 1.4;
}

.share-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.share-title {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 22px;
  line-height: 1.3;
}

.share-subtitle {
  margin: 8px 0 20px;
  color: #64748b;
  font-size: 14px;
  line-height: 1.6;
}

.preview-frame {
  display: grid;
  min-height: 320px;
  margin-bottom: 16px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  overflow: hidden;
  place-items: center;
  background: #f8fafc;
}

.preview-loading {
  min-height: 160px;
}

.preview-frame img,
.preview-frame video,
.preview-frame iframe {
  width: 100%;
  max-height: 70vh;
  border: 0;
  object-fit: contain;
}

.preview-frame iframe {
  min-height: 520px;
}

.text-preview {
  place-items: stretch;
  overflow: auto;
}

.text-preview-body {
  margin: 0;
  padding: 16px;
  min-height: 320px;
  max-height: 70vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "Fira Code", "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
  font-size: 13px;
  line-height: 1.55;
  color: #0f172a;
  background: #ffffff;
  text-align: left;
}

.office-fallback {
  padding: 28px 20px;
  text-align: center;
  color: #64748b;
  line-height: 1.6;
}

.preview-frame audio {
  width: min(520px, calc(100% - 32px));
}

.share-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.share-footer {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid #e2e8f0;
  color: #94a3b8;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}

.powered-by {
  margin-top: 4px;
  opacity: 0.85;
}

.muted {
  color: #64748b;
}

@media (max-width: 640px) {
  .share-page {
    padding: 12px;
  }

  .share-panel {
    padding: 16px;
  }

  .share-actions {
    flex-direction: column;
  }

  .share-actions .el-button {
    width: 100%;
    margin-left: 0;
  }
}
</style>
