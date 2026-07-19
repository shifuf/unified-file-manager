<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">系统设置</h1>
        <p class="page-subtitle">维护上传限制、回收站策略、公开域名与消息通知对接。</p>
      </div>
      <el-button :icon="Refresh" @click="reloadAll">刷新</el-button>
    </div>

    <section class="surface">
      <div class="surface-body">
        <div class="section-title">全局配置</div>
        <el-form
          ref="settingsFormRef"
          v-loading="settingsLoading"
          :model="settingsForm"
          :rules="settingsRules"
          label-position="top"
          class="settings-form"
        >
          <div class="settings-grid">
            <el-form-item label="单个文件大小（MB）" prop="maxFileSizeMb">
              <el-input-number
                v-model="settingsForm.maxFileSizeMb"
                :min="1"
                :step="10"
                controls-position="right"
                class="setting-input"
              />
              <div class="setting-help">超过这个大小的文件不能上传。</div>
            </el-form-item>
            <el-form-item label="单次上传数量" prop="maxBatchUploadCount">
              <el-input-number
                v-model="settingsForm.maxBatchUploadCount"
                :min="1"
                :step="1"
                controls-position="right"
                class="setting-input"
              />
              <div class="setting-help">一次选择上传时允许的最多文件数。</div>
            </el-form-item>
            <el-form-item label="回收站保留天数" prop="recycleRetentionDays">
              <el-input-number
                v-model="settingsForm.recycleRetentionDays"
                :min="1"
                :step="1"
                controls-position="right"
                class="setting-input"
              />
              <div class="setting-help">到期后文件可被彻底清理。</div>
            </el-form-item>
            <el-form-item label="要求 HTTPS 访问" prop="requireHttps">
              <el-switch v-model="settingsForm.requireHttps" active-text="开启" inactive-text="关闭" />
              <div class="setting-help">开启后，外部访问地址应使用 HTTPS。</div>
            </el-form-item>
            <el-form-item class="settings-wide" label="公开文件允许访问域名" prop="publicFileAllowedDomains">
              <el-input
                v-model="settingsForm.publicFileAllowedDomains"
                type="textarea"
                :rows="3"
                placeholder="a.xxx&#10;*.xxx"
              />
              <div class="setting-help">
                每行或逗号分隔一个来源站点域名，支持 *.example.com。公开图片会校验 Origin/Referer，留空时默认只允许当前访问域名。
              </div>
            </el-form-item>
            <el-form-item class="settings-wide" label="Office 在线预览服务" prop="officePreviewBaseUrl">
              <el-input
                v-model="settingsForm.officePreviewBaseUrl"
                clearable
                placeholder="例如 https://kkfile.example.com/onlinePreview?url= 或 OnlyOffice 文档服务根地址"
              />
              <div class="setting-help">
                配置 KKFileView / OnlyOffice 等预览服务后，Office 文档可在线打开。留空则仅提供下载。KKFileView 示例：
                <code>http://host:8012/onlinePreview?url=</code>（系统会把文件直链做 URL 编码后拼接）。
              </div>
            </el-form-item>
          </div>
          <div class="form-actions">
            <el-button type="primary" :icon="Check" :loading="settingsSaving" @click="saveSettings">保存设置</el-button>
            <el-button @click="restoreSettingsForm">恢复当前值</el-button>
          </div>
        </el-form>
      </div>
    </section>

    <section class="surface" style="margin-top: 16px">
      <div class="surface-body">
        <div class="section-title">自定义分享页</div>
        <p class="section-help">
          作用于公开文件分享页 <code>/shares/:token</code> 与目录分享页
          <code>/folder-shares/:token</code>。留空标题/副标题/Logo 则不显示品牌区。
        </p>
        <el-form v-loading="settingsLoading" label-position="top" class="settings-form" :model="brandForm">
          <div class="settings-grid">
            <el-form-item label="品牌标题">
              <el-input v-model="brandForm.title" maxlength="64" show-word-limit placeholder="例如：某某团队文件中心" />
            </el-form-item>
            <el-form-item label="副标题">
              <el-input v-model="brandForm.subtitle" maxlength="160" show-word-limit placeholder="例如：安全分享 · 限时访问" />
            </el-form-item>
            <el-form-item class="settings-wide" label="Logo URL">
              <el-input v-model="brandForm.logoUrl" clearable placeholder="https://cdn.example.com/logo.png" />
              <div class="setting-help">仅支持 http/https 图片地址。</div>
            </el-form-item>
            <el-form-item label="主题色">
              <div class="color-row">
                <el-color-picker v-model="brandForm.primaryColor" />
                <el-input v-model="brandForm.primaryColor" placeholder="#2563eb" />
              </div>
            </el-form-item>
            <el-form-item label="面板背景">
              <div class="color-row">
                <el-color-picker v-model="brandForm.panelBackground" />
                <el-input v-model="brandForm.panelBackground" placeholder="#ffffff" />
              </div>
            </el-form-item>
            <el-form-item class="settings-wide" label="页面背景">
              <el-input
                v-model="brandForm.background"
                placeholder="#f8fafc 或 linear-gradient(135deg,#eff6ff,#f8fafc)"
              />
              <div class="setting-help">支持纯色或 linear-gradient；不允许 url()。</div>
            </el-form-item>
            <el-form-item class="settings-wide" label="页脚文案">
              <el-input v-model="brandForm.footerText" maxlength="160" show-word-limit placeholder="例如：仅供内部使用，禁止外传" />
            </el-form-item>
            <el-form-item label="显示「由统一文件管理提供」">
              <el-switch v-model="brandForm.showPoweredBy" active-text="显示" inactive-text="隐藏" />
            </el-form-item>
          </div>
          <div class="form-actions">
            <el-button type="primary" :loading="brandSaving" @click="saveBrand">保存分享页样式</el-button>
            <el-button @click="restoreBrandForm">恢复当前值</el-button>
          </div>
        </el-form>
      </div>
    </section>

    <section class="surface" style="margin-top: 16px">
      <div class="surface-body">
        <div class="section-title">消息通知（对接消息推送平台）</div>
        <el-form v-loading="notifyLoading" label-position="top" class="settings-form" :model="notifyForm">
          <div class="settings-grid">
            <el-form-item label="启用通知">
              <el-switch v-model="notifyForm.enabled" active-text="开启" inactive-text="关闭" />
            </el-form-item>
            <el-form-item class="settings-wide" label="平台地址 baseUrl">
              <el-input v-model="notifyForm.baseUrl" placeholder="https://notify.example.com 或 http://localhost:3000" />
              <div class="setting-help">将请求 POST {baseUrl}/api/webhook，使用 Bearer API Key。</div>
            </el-form-item>
            <el-form-item class="settings-wide" label="API Key">
              <el-input
                v-model="notifyForm.apiKey"
                type="password"
                show-password
                :placeholder="notifyForm.apiKeyConfigured ? '已配置，留空表示不修改' : 'msg_xxxx…'"
              />
              <div class="setting-help">
                密钥加密存储，界面永不回显明文。
                <el-button
                  v-if="notifyForm.apiKeyConfigured"
                  link
                  type="danger"
                  @click="clearNotifyKey"
                >
                  清除已保存密钥
                </el-button>
              </div>
            </el-form-item>
            <el-form-item class="settings-wide" label="推送事件">
              <el-select v-model="notifyForm.events" multiple collapse-tags collapse-tags-tooltip style="width: 100%">
                <el-option v-for="item in notifyEventOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
          </div>
          <div class="form-actions">
            <el-button type="primary" :loading="notifySaving" @click="saveNotify">保存通知配置</el-button>
            <el-button :loading="notifyTesting" @click="testNotify">发送测试消息</el-button>
          </div>
        </el-form>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Check, Refresh } from '@element-plus/icons-vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';

import { settingsApi } from '@/api/modules';
import type { SharePageBrand } from '@/types';

const settingsLoading = ref(false);
const settingsSaving = ref(false);
const brandSaving = ref(false);
const notifyLoading = ref(false);
const notifySaving = ref(false);
const notifyTesting = ref(false);
const settingsFormRef = ref<FormInstance>();
const settings = ref<Record<string, unknown>>({});
type SystemSettingKey =
  | 'maxFileSizeMb'
  | 'maxBatchUploadCount'
  | 'recycleRetentionDays'
  | 'requireHttps'
  | 'publicFileAllowedDomains'
  | 'officePreviewBaseUrl';

interface SettingsForm {
  maxFileSizeMb: number;
  maxBatchUploadCount: number;
  recycleRetentionDays: number;
  requireHttps: boolean;
  publicFileAllowedDomains: string;
  officePreviewBaseUrl: string;
}

const settingKeys: SystemSettingKey[] = [
  'maxFileSizeMb',
  'maxBatchUploadCount',
  'recycleRetentionDays',
  'requireHttps',
  'publicFileAllowedDomains',
  'officePreviewBaseUrl',
];
const settingsForm = reactive<SettingsForm>({
  maxFileSizeMb: 200,
  maxBatchUploadCount: 20,
  recycleRetentionDays: 30,
  requireHttps: true,
  publicFileAllowedDomains: '',
  officePreviewBaseUrl: '',
});
const originalSettings = ref<SettingsForm>({ ...settingsForm });
const defaultBrand = (): SharePageBrand => ({
  title: '',
  subtitle: '',
  logoUrl: '',
  primaryColor: '#2563eb',
  background: '#f8fafc',
  panelBackground: '#ffffff',
  footerText: '',
  showPoweredBy: true,
});
const brandForm = reactive<SharePageBrand>(defaultBrand());
const originalBrand = ref<SharePageBrand>(defaultBrand());
const settingsRules: FormRules = {
  maxFileSizeMb: [{ required: true, type: 'number', min: 1, message: '请填写单个文件大小。', trigger: 'blur' }],
  maxBatchUploadCount: [{ required: true, type: 'number', min: 1, message: '请填写单次上传数量。', trigger: 'blur' }],
  recycleRetentionDays: [{ required: true, type: 'number', min: 1, message: '请填写回收站保留天数。', trigger: 'blur' }],
};

const notifyEventOptions = [
  { value: 'file.uploaded', label: '文件上传' },
  { value: 'file.deleted', label: '文件删除' },
  { value: 'share.downloaded', label: '分享下载' },
  { value: 'share.download.rate_limited', label: '分享下载触发防刷限流（含 IP）' },
  { value: 'quota.exceeded', label: '配额超限' },
  { value: 'cdn.health.fail', label: '存储健康失败' },
];

const notifyForm = reactive({
  enabled: false,
  baseUrl: '',
  apiKey: '',
  apiKeyConfigured: false,
  events: [] as string[],
  clearApiKey: false,
});

async function reloadAll(): Promise<void> {
  await Promise.all([loadSettings(), loadNotify()]);
}

async function loadSettings(): Promise<void> {
  settingsLoading.value = true;
  try {
    settings.value = await settingsApi.list();
    applySettingsToForm(settings.value);
  } finally {
    settingsLoading.value = false;
  }
}

async function loadNotify(): Promise<void> {
  notifyLoading.value = true;
  try {
    const data = await settingsApi.getNotify();
    notifyForm.enabled = data.enabled;
    notifyForm.baseUrl = data.baseUrl || '';
    notifyForm.apiKeyConfigured = data.apiKeyConfigured;
    notifyForm.events = data.events || [];
    notifyForm.apiKey = '';
    notifyForm.clearApiKey = false;
  } finally {
    notifyLoading.value = false;
  }
}

async function saveSettings(): Promise<void> {
  const valid = await settingsFormRef.value?.validate();
  if (!valid) {
    return;
  }

  const changedKeys = settingKeys.filter((key) => settingsForm[key] !== originalSettings.value[key]);
  if (changedKeys.length === 0) {
    ElMessage.info('没有需要保存的修改。');
    return;
  }

  settingsSaving.value = true;
  try {
    await Promise.all(changedKeys.map((key) => settingsApi.update({ key, value: settingsForm[key] })));
    ElMessage.success('系统设置已保存。');
    await loadSettings();
  } finally {
    settingsSaving.value = false;
  }
}

async function saveNotify(): Promise<void> {
  notifySaving.value = true;
  try {
    const data = await settingsApi.updateNotify({
      enabled: notifyForm.enabled,
      baseUrl: notifyForm.baseUrl,
      apiKey: notifyForm.apiKey || undefined,
      clearApiKey: notifyForm.clearApiKey || undefined,
      events: notifyForm.events,
    });
    notifyForm.enabled = data.enabled;
    notifyForm.baseUrl = data.baseUrl || '';
    notifyForm.apiKeyConfigured = data.apiKeyConfigured;
    notifyForm.events = data.events || [];
    notifyForm.apiKey = '';
    notifyForm.clearApiKey = false;
    ElMessage.success('消息通知配置已保存。');
  } finally {
    notifySaving.value = false;
  }
}

async function testNotify(): Promise<void> {
  notifyTesting.value = true;
  try {
    const result = await settingsApi.testNotify();
    if (result.success) {
      ElMessage.success(`测试消息已发送${result.messageId ? `（${result.messageId}）` : ''}。`);
    } else if (result.skipped) {
      ElMessage.warning(result.reason || '通知未发送（已跳过）。');
    } else {
      ElMessage.error(result.reason || '测试消息发送失败。');
    }
  } finally {
    notifyTesting.value = false;
  }
}

function clearNotifyKey(): void {
  notifyForm.clearApiKey = true;
  notifyForm.apiKey = '';
  ElMessage.info('将在保存时清除已配置的 API Key。');
}

function restoreSettingsForm(): void {
  applySettingsToForm(settings.value);
}

function restoreBrandForm(): void {
  applyBrandToForm(settings.value.sharePageBrand);
}

async function saveBrand(): Promise<void> {
  brandSaving.value = true;
  try {
    await settingsApi.update({
      key: 'sharePageBrand',
      value: {
        title: brandForm.title,
        subtitle: brandForm.subtitle,
        logoUrl: brandForm.logoUrl,
        primaryColor: brandForm.primaryColor,
        background: brandForm.background,
        panelBackground: brandForm.panelBackground,
        footerText: brandForm.footerText,
        showPoweredBy: brandForm.showPoweredBy,
      },
    });
    ElMessage.success('分享页样式已保存。');
    await loadSettings();
  } finally {
    brandSaving.value = false;
  }
}

function applySettingsToForm(source: Record<string, unknown>): void {
  settingsForm.maxFileSizeMb = readPositiveInteger(source.maxFileSizeMb, 200);
  settingsForm.maxBatchUploadCount = readPositiveInteger(source.maxBatchUploadCount, 20);
  settingsForm.recycleRetentionDays = readPositiveInteger(source.recycleRetentionDays, 30);
  settingsForm.requireHttps = typeof source.requireHttps === 'boolean' ? source.requireHttps : true;
  settingsForm.publicFileAllowedDomains = readDomainAllowlist(source.publicFileAllowedDomains).join('\n');
  settingsForm.officePreviewBaseUrl =
    typeof source.officePreviewBaseUrl === 'string' ? source.officePreviewBaseUrl : '';
  originalSettings.value = { ...settingsForm };
  applyBrandToForm(source.sharePageBrand);
}

function applyBrandToForm(value: unknown): void {
  const defaults = defaultBrand();
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  brandForm.title = typeof source.title === 'string' ? source.title : defaults.title;
  brandForm.subtitle = typeof source.subtitle === 'string' ? source.subtitle : defaults.subtitle;
  brandForm.logoUrl = typeof source.logoUrl === 'string' ? source.logoUrl : defaults.logoUrl;
  brandForm.primaryColor =
    typeof source.primaryColor === 'string' ? source.primaryColor : defaults.primaryColor;
  brandForm.background = typeof source.background === 'string' ? source.background : defaults.background;
  brandForm.panelBackground =
    typeof source.panelBackground === 'string' ? source.panelBackground : defaults.panelBackground;
  brandForm.footerText = typeof source.footerText === 'string' ? source.footerText : defaults.footerText;
  brandForm.showPoweredBy =
    typeof source.showPoweredBy === 'boolean' ? source.showPoweredBy : defaults.showPoweredBy;
  originalBrand.value = { ...brandForm };
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.floor(parsed);
}

function readDomainAllowlist(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

onMounted(async () => {
  await reloadAll();
});
</script>

<style scoped>
.section-title {
  margin-bottom: 12px;
  font-weight: 700;
}

.section-help {
  margin: -4px 0 14px;
  color: #64748b;
  font-size: 13px;
  line-height: 1.55;
}

.color-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.color-row .el-input {
  flex: 1;
}

.settings-form {
  max-width: 960px;
}

.settings-grid {
  display: grid;
  gap: 16px 20px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.setting-input {
  width: 220px;
  max-width: 100%;
}

.settings-wide {
  grid-column: 1 / -1;
}

.setting-help {
  width: 100%;
  margin-top: 6px;
  color: #64748b;
  font-size: 13px;
  line-height: 1.5;
}

.form-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

@media (max-width: 760px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }

  .form-actions {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
