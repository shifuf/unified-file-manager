<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">存储配置</h1>
        <p class="page-subtitle">维护当前项目或全局共享的本地、七牛云、又拍云或阿里 OSS 存储配置。</p>
      </div>
      <el-button
        v-if="canCreateConfig"
        type="primary"
        :icon="Plus"
        @click="openCreateDialog"
      >
        {{ createButtonLabel }}
      </el-button>
    </div>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar">
          <el-select
            v-model="selectedProjectId"
            filterable
            clearable
            placeholder="选择项目以标记生效配置"
            style="width: 300px"
            @change="reload"
          >
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-button :icon="Refresh" @click="reload">刷新</el-button>
        </div>

        <el-table v-loading="loading" :data="configs" row-key="id" class="data-table">
          <el-table-column prop="name" label="配置名称" min-width="180" />
          <el-table-column prop="provider" label="平台" width="120">
            <template #default="{ row }">
              <el-tag>{{ providerLabel(row.provider) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="范围" width="120">
            <template #default="{ row }">
              <el-tag :type="row.projectId ? 'success' : 'info'">{{ scopeLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="selectedProjectId ? '当前项目状态' : '配置状态'" width="140">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'">{{ row.active ? '生效' : '可选' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="配置摘要" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="config-summary">{{ summarizeConfig(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="云用量" min-width="220">
            <template #default="{ row }">
              <div v-if="['QINIU', 'UPYUN'].includes(row.provider) || row.storageQuotaBytes != null || row.manualStorageUsedBytes != null || row.trafficQuotaBytes != null || row.manualTrafficUsedBytes != null" class="usage-cell">
                <template v-if="usageLoadingId === row.id">
                  <span class="muted">加载中…</span>
                </template>
                <template v-else-if="usageByConfigId[row.id]">
                  <div v-if="usageByConfigId[row.id]?.storageUsedBytes == null && row.manualStorageUsedBytes == null" class="muted">
                    平台未提供空间用量
                    <span v-if="row.storageQuotaBytes != null">· 上限 {{ formatBytes(Number(row.storageQuotaBytes)) }}</span>
                  </div>
                    <div>
                      空间 {{ formatBytes(usageByConfigId[row.id]?.storageUsedBytes ?? (row.manualStorageUsedBytes == null ? null : Number(row.manualStorageUsedBytes))) }}
                      <span v-if="usageByConfigId[row.id]?.storageQuotaBytes != null || row.storageQuotaBytes != null">
                        / {{ formatBytes(usageByConfigId[row.id]?.storageQuotaBytes ?? Number(row.storageQuotaBytes)) }}
                      </span>
                      <el-tag size="small" type="info">{{ usageByConfigId[row.id]?.storageUsedSource === 'provider' ? '平台' : row.manualStorageUsedBytes != null ? '手动' : '未知' }}</el-tag>
                    </div>
                    <el-progress
                      v-if="usagePercent(usageByConfigId[row.id]) != null"
                      :percentage="usagePercent(usageByConfigId[row.id])!"
                      :stroke-width="6"
                      :show-text="false"
                      style="margin: 4px 0"
                    />
                    <div v-if="usageByConfigId[row.id]?.trafficUsedBytes != null || row.manualTrafficUsedBytes != null" class="muted usage-sub">
                      流量 {{ formatBytes(usageByConfigId[row.id]?.trafficUsedBytes ?? Number(row.manualTrafficUsedBytes)) }}
                      <span v-if="usageByConfigId[row.id]?.trafficQuotaBytes != null || row.trafficQuotaBytes != null">
                        / {{ formatBytes(usageByConfigId[row.id]?.trafficQuotaBytes ?? Number(row.trafficQuotaBytes)) }}
                      </span>
                      <el-tag size="small" type="warning">{{ usageByConfigId[row.id]?.trafficUsedSource === 'provider' ? '平台回报' : usageByConfigId[row.id]?.trafficUsedSource === 'manual' ? '手动填报' : '未知' }} · 不等同 CDN 账单</el-tag>
                    </div>
                    <div v-else-if="usageByConfigId[row.id]?.message" class="muted usage-sub" :title="usageByConfigId[row.id]?.message">
                      {{ shortMessage(usageByConfigId[row.id]?.message) }}
                    </div>
                </template>
                <template v-else>
                  <span class="muted">未加载</span>
                </template>
              </div>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="320">
            <template #default="{ row }">
              <div class="table-actions">
                <el-button link type="primary" :loading="testingConfigId === row.id" @click="testConfig(row)">
                  测试
                </el-button>
                <el-button
                  v-if="['QINIU', 'UPYUN'].includes(row.provider) || row.autoFailover"
                  link
                  type="primary"
                  :loading="usageLoadingId === row.id"
                  @click="loadUsage(row, true)"
                >
                  刷新用量
                </el-button>
                <el-button
                  v-if="canManageSelectedProject"
                  link
                  type="primary"
                  :disabled="row.active"
                  @click="activate(row)"
                >
                  设为当前项目存储
                </el-button>
                <el-button v-if="canEditConfig(row)" link type="primary" @click="openEditDialog(row)">编辑</el-button>
                <el-button
                  v-if="canRemoveConfig(row)"
                  link
                  type="danger"
                  :disabled="row.active"
                  @click="removeConfig(row)"
                >
                  删除
                </el-button>
                <span v-if="!canManageSelectedProject && !canEditConfig(row) && !canRemoveConfig(row)" class="muted">-</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <el-dialog v-model="dialogVisible" :title="editingConfig ? '编辑存储配置' : '新建存储配置'" width="680px">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="平台" prop="provider">
          <el-segmented v-model="form.provider" :options="providerOptions" @change="fillTemplate" />
        </el-form-item>
        <el-form-item label="配置名称" prop="name">
          <el-input v-model="form.name" maxlength="128" show-word-limit />
        </el-form-item>
        <div class="config-section">
          <div class="config-section-title">平台配置</div>
          <div class="config-field-grid">
            <el-form-item
              v-for="field in currentHelp.fields"
              :key="field.key"
              :label="field.label"
              :required="field.required"
              class="config-field-item"
            >
              <el-input
                v-model="form.configValues[field.key]"
                :type="field.secret ? 'password' : 'text'"
                :show-password="field.secret"
                :placeholder="field.placeholder"
                autocomplete="off"
              />
              <div v-if="field.help" class="field-help">{{ field.help }}</div>
            </el-form-item>
          </div>
          <div class="config-help">{{ currentHelp.description }}</div>
        </div>
        <div class="config-section">
          <div class="config-section-title">用量与自动切换</div>
          <div class="config-field-grid">
            <el-form-item label="优先级（数字越小越优先）"><el-input-number v-model="form.priority" :min="0" :max="100000" /></el-form-item>
            <el-form-item label="切换阈值 (%)"><el-input-number v-model="form.failoverThresholdPercent" :min="1" :max="100" /></el-form-item>
            <el-form-item label="空间上限 (GiB)"><el-input-number v-model="form.storageQuotaGiB" :min="0" :precision="2" clearable :value-on-clear="null" /></el-form-item>
            <el-form-item label="手动已用空间 (GiB)"><el-input-number v-model="form.manualStorageUsedGiB" :min="0" :precision="2" clearable :value-on-clear="null" /></el-form-item>
            <el-form-item label="流量上限 (GiB)"><el-input-number v-model="form.trafficQuotaGiB" :min="0" :precision="2" clearable :value-on-clear="null" /></el-form-item>
            <el-form-item label="手动已用流量 (GiB)"><el-input-number v-model="form.manualTrafficUsedGiB" :min="0" :precision="2" clearable :value-on-clear="null" /></el-form-item>
          </div>
          <el-checkbox v-model="form.autoFailover">达到阈值后自动切换新上传目标</el-checkbox>
          <div class="field-help">平台用量优先使用平台回报；查不到时使用这里录入的用量。应用访问统计不等同于 CDN 账单流量。</div>
        </div>
        <el-checkbox v-if="selectedProjectId && canManageSelectedProject" v-model="form.selectForProject">
          保存后设为当前项目存储
        </el-checkbox>
      </el-form>

      <div v-if="draftTestResult" class="draft-test-panel">
        <el-alert
          :type="draftTestResult.success ? 'success' : 'error'"
          :closable="false"
          show-icon
          :title="draftTestResult.success ? '连接测试通过，可以保存' : '连接测试未通过，请修正配置'"
        />
        <el-table :data="draftTestResult.checks" row-key="name" size="small" style="margin-top: 8px">
          <el-table-column prop="name" label="检查项" width="140" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="checkTagType(row.status)">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="message" label="结果" min-width="240" show-overflow-tooltip />
        </el-table>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button :icon="Connection" :loading="draftTesting" @click="testDraftConfig">测试连接</el-button>
          <div class="dialog-footer-right">
            <el-button @click="dialogVisible = false">取消</el-button>
            <el-tooltip
              :disabled="saveEnabled"
              content="请先完成“测试连接”并通过后再保存"
              placement="top"
            >
              <span>
                <el-button type="primary" :loading="submitting" :disabled="!saveEnabled" @click="submitConfig">
                  保存
                </el-button>
              </span>
            </el-tooltip>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="healthDialogVisible" title="存储测试结果" width="620px">
      <div v-if="healthResult" class="health-panel">
        <div class="health-head">
          <div>
            <div class="section-title">{{ healthResult.name }}</div>
            <div class="muted">{{ providerLabel(healthResult.provider) }} · {{ formatTime(healthResult.checkedAt) }}</div>
          </div>
          <el-tag :type="healthResult.success ? 'success' : 'danger'">
            {{ healthResult.success ? '通过' : '失败' }}
          </el-tag>
        </div>
        <el-table :data="healthResult.checks" row-key="name" size="small">
          <el-table-column prop="name" label="检查项" width="140" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="checkTagType(row.status)">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="message" label="结果" min-width="240" show-overflow-tooltip />
        </el-table>
        <div v-if="healthResult.usage" class="usage-panel">
          <div class="section-title" style="margin-top: 16px">云用量</div>
          <div v-if="!healthResult.usage.supported" class="muted">当前平台不支持云用量查询。</div>
          <template v-else>
            <div class="usage-grid">
              <div class="usage-metric">
                <div class="muted">已用空间</div>
                <div class="usage-value">{{ formatBytes(healthResult.usage.storageUsedBytes) }}</div>
                <div v-if="healthResult.usage.storageQuotaBytes != null" class="muted">
                  配额 {{ formatBytes(healthResult.usage.storageQuotaBytes) }}
                </div>
              </div>
              <div class="usage-metric">
                <div class="muted">本月流量</div>
                <div class="usage-value">{{ formatBytes(healthResult.usage.trafficUsedBytes) }}</div>
                <div v-if="healthResult.usage.trafficQuotaBytes != null" class="muted">
                  配额 {{ formatBytes(healthResult.usage.trafficQuotaBytes) }}
                </div>
              </div>
            </div>
            <div v-if="healthResult.usage.message" class="muted" style="margin-top: 8px">
              {{ healthResult.usage.message }}
            </div>
          </template>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Connection, Plus, Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { cdnApi, projectApi } from '@/api/modules';
import { useAuthStore } from '@/stores/auth';
import type { CdnConfig, CdnProvider, Project, StorageHealthResult, StorageUsageResult } from '@/types';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const loading = ref(false);
const submitting = ref(false);
const testingConfigId = ref('');
const usageLoadingId = ref('');
const usageByConfigId = ref<Record<string, StorageUsageResult>>({});
const projects = ref<Project[]>([]);
const configs = ref<CdnConfig[]>([]);
const healthDialogVisible = ref(false);
const healthResult = ref<StorageHealthResult | null>(null);
const selectedProjectId = ref(String(route.query.projectId || ''));
const selectedProject = computed(() => projects.value.find((project) => project.id === selectedProjectId.value));
const canManageSelectedProject = computed(() => Boolean(selectedProject.value?.canManage));
const canCreateConfig = computed(() => authStore.isSuperAdmin || canManageSelectedProject.value);
const createButtonLabel = computed(() =>
  selectedProjectId.value && canManageSelectedProject.value ? '新建项目配置' : '新建全局配置',
);
const dialogVisible = ref(false);
const editingConfig = ref<CdnConfig | null>(null);
const draftTesting = ref(false);
const draftTestResult = ref<StorageHealthResult | null>(null);
/** Fingerprint of the tested payload; any field change invalidates the result. */
const draftTestedKey = ref('');
const formRef = ref<FormInstance>();
const providerOptions = [
  { label: '本地', value: 'LOCAL' },
  { label: '七牛云', value: 'QINIU' },
  { label: '又拍云', value: 'UPYUN' },
  { label: '阿里 OSS', value: 'ALIYUN' },
  { label: 'S3 兼容', value: 'S3' },
];
const MASKED_SECRET = '******';
interface ConfigField {
  key: string;
  label: string;
  required: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

interface ProviderHelp {
  description: string;
  fields: ConfigField[];
}

const providerHelp: Record<CdnProvider, ProviderHelp> = {
  LOCAL: {
    description: '本地存储需要保存目录和对外访问域名。',
    fields: [
      { key: 'root', label: '保存目录', required: true, placeholder: './storage' },
      { key: 'domain', label: '访问域名', required: true, placeholder: 'http://localhost:60557' },
    ],
  },
  QINIU: {
    description: '编辑已有配置时，密钥保持 ****** 会沿用原值。',
    fields: [
      { key: 'accessKey', label: 'AccessKey', required: true, placeholder: 'AKxxxx' },
      { key: 'secretKey', label: 'SecretKey', required: true, secret: true, placeholder: 'SKxxxx' },
      { key: 'bucket', label: 'Bucket', required: true, placeholder: 'assets-prod' },
      { key: 'domain', label: '访问域名', required: true, placeholder: 'https://assets.example.com' },
    ],
  },
  UPYUN: {
    description: '接口地址可不填，默认使用又拍云接口。',
    fields: [
      { key: 'bucket', label: '服务名', required: true, placeholder: 'assets-prod' },
      { key: 'operator', label: '操作员', required: true, placeholder: 'operator-name' },
      { key: 'password', label: '密码', required: true, secret: true, placeholder: 'operator-password' },
      { key: 'domain', label: '访问域名', required: true, placeholder: 'https://assets.example.com' },
      { key: 'endpoint', label: '接口地址', required: false, placeholder: 'https://v0.api.upyun.com' },
      {
        key: 'tokenSecret',
        label: 'Token 密钥',
        required: false,
        secret: true,
        placeholder: '防盗链/签名密钥，可留空',
        help: '用于生成 _upt 防盗链签名；留空则直接使用公开域名直链。',
      },
    ],
  },
  ALIYUN: {
    description: 'Endpoint 填 OSS 地域节点，不需要带 https://。',
    fields: [
      { key: 'accessKey', label: 'AccessKey', required: true, placeholder: 'LTAIxxxx' },
      { key: 'secretKey', label: 'SecretKey', required: true, secret: true, placeholder: 'secret' },
      { key: 'bucket', label: 'Bucket', required: true, placeholder: 'assets-prod' },
      { key: 'endpoint', label: 'Endpoint', required: true, placeholder: 'oss-cn-hangzhou.aliyuncs.com' },
      { key: 'domain', label: '访问域名', required: true, placeholder: 'https://assets.example.com' },
    ],
  },
  S3: {
    description: '兼容 AWS S3 / MinIO / R2 / COS S3 接口。path-style 默认开启。',
    fields: [
      { key: 'endpoint', label: 'Endpoint', required: true, placeholder: 'https://s3.amazonaws.com' },
      { key: 'region', label: 'Region', required: true, placeholder: 'us-east-1' },
      { key: 'bucket', label: 'Bucket', required: true, placeholder: 'assets-prod' },
      { key: 'accessKeyId', label: 'AccessKeyId', required: true, placeholder: 'AKIA...' },
      { key: 'secretAccessKey', label: 'SecretAccessKey', required: true, secret: true, placeholder: 'secret' },
      { key: 'publicBaseUrl', label: '公开访问域名', required: false, placeholder: 'https://cdn.example.com' },
      { key: 'forcePathStyle', label: 'Path Style (true/false)', required: false, placeholder: 'true' },
    ],
  },
};
const form = reactive({
  provider: 'LOCAL' as CdnProvider,
  name: '',
  configValues: {} as Record<string, string>,
  selectForProject: false,
  priority: 100,
  failoverThresholdPercent: 90,
  storageQuotaGiB: null as number | null,
  manualStorageUsedGiB: null as number | null,
  trafficQuotaGiB: null as number | null,
  manualTrafficUsedGiB: null as number | null,
  autoFailover: false,
});
const rules: FormRules = {
  provider: [{ required: true, message: '请选择存储平台。', trigger: 'change' }],
  name: [{ required: true, message: '请输入配置名称。', trigger: 'blur' }],
};
const currentHelp = computed(() => providerHelp[form.provider]);

function providerLabel(provider: CdnProvider): string {
  const option = providerOptions.find((item) => item.value === provider);
  return option?.label || provider;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatBytes(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return '—';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function usagePercent(usage?: StorageUsageResult): number | null {
  if (!usage || usage.storageUsedBytes == null || usage.storageQuotaBytes == null || usage.storageQuotaBytes <= 0) {
    return null;
  }
  return Math.min(100, Math.round((usage.storageUsedBytes / usage.storageQuotaBytes) * 1000) / 10);
}

function shortMessage(message?: string): string {
  if (!message) {
    return '';
  }
  return message.length > 36 ? `${message.slice(0, 36)}…` : message;
}

function checkTagType(status: string): 'success' | 'warning' | 'danger' {
  if (status === 'PASS') {
    return 'success';
  }

  return status === 'WARN' ? 'warning' : 'danger';
}

function summarizeConfig(config: CdnConfig): string {
  const fields = providerHelp[config.provider].fields;
  const parts = fields
    .filter((field) => !field.secret && config.config[field.key] !== undefined && config.config[field.key] !== '')
    .map((field) => `${field.label}=${String(config.config[field.key])}`);

  return parts.length > 0 ? parts.join(' / ') : '未填写';
}

function scopeLabel(config: CdnConfig): string {
  return config.projectId ? '当前项目' : '全局共享';
}

function configProjectScope(config: CdnConfig): string | undefined {
  return config.projectId ? config.projectId : undefined;
}

function canEditConfig(config: CdnConfig): boolean {
  if (config.projectId) {
    return config.projectId === selectedProjectId.value && canManageSelectedProject.value;
  }

  return authStore.isSuperAdmin;
}

function canRemoveConfig(config: CdnConfig): boolean {
  return canEditConfig(config);
}

function fillTemplate(): void {
  const source = editingConfig.value?.provider === form.provider ? editingConfig.value.config : {};
  form.configValues = buildConfigValues(form.provider, source);
}

async function loadProjects(): Promise<void> {
  projects.value = await projectApi.list();
  selectedProjectId.value = selectedProjectId.value || projects.value[0]?.id || '';
  await reload();
}

async function reload(): Promise<void> {
  const query = selectedProjectId.value ? { projectId: selectedProjectId.value } : {};
  void router.replace({ path: '/storage-configs', query });
  loading.value = true;
  try {
    configs.value = await cdnApi.list(selectedProjectId.value || undefined);
    void loadUsageForCloudConfigs();
  } finally {
    loading.value = false;
  }
}

async function loadUsage(config: CdnConfig, force = false): Promise<void> {
  if (config.provider !== 'QINIU' && config.provider !== 'UPYUN') {
    return;
  }
  if (!force && usageByConfigId.value[config.id]) {
    return;
  }
  usageLoadingId.value = config.id;
  try {
    const usage = await cdnApi.usage(config.id, configProjectScope(config));
    usageByConfigId.value = { ...usageByConfigId.value, [config.id]: usage };
  } catch {
    usageByConfigId.value = {
      ...usageByConfigId.value,
      [config.id]: {
        provider: config.provider,
        name: config.name,
        configId: config.id,
        supported: true,
        storageUsedBytes: null,
        storageQuotaBytes: null,
        trafficUsedBytes: null,
        trafficQuotaBytes: null,
        checkedAt: new Date().toISOString(),
        message: '用量查询失败',
      },
    };
  } finally {
    usageLoadingId.value = '';
  }
}

async function loadUsageForCloudConfigs(): Promise<void> {
  const cloud = configs.value.filter((item) => item.provider === 'QINIU' || item.provider === 'UPYUN');
  // Sequential with small concurrency to avoid provider rate limits.
  const queue = [...cloud];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (next) {
        await loadUsage(next);
      }
    }
  });
  await Promise.all(workers);
}

function openCreateDialog(): void {
  if (!canCreateConfig.value) {
    return;
  }

  editingConfig.value = null;
  form.provider = 'ALIYUN';
  form.name = '';
  Object.assign(form, { priority: 100, failoverThresholdPercent: 90, storageQuotaGiB: null, manualStorageUsedGiB: null, trafficQuotaGiB: null, manualTrafficUsedGiB: null, autoFailover: false });
  form.selectForProject = Boolean(selectedProjectId.value && canManageSelectedProject.value);
  form.configValues = buildConfigValues(form.provider);
  resetDraftTest();
  dialogVisible.value = true;
}

function openEditDialog(config: CdnConfig): void {
  if (!canEditConfig(config)) {
    return;
  }

  editingConfig.value = config;
  form.provider = config.provider;
  form.name = config.name;
  Object.assign(form, {
    priority: config.priority ?? 100,
    failoverThresholdPercent: config.failoverThresholdPercent ?? 90,
    storageQuotaGiB: config.storageQuotaBytes == null ? null : Number(config.storageQuotaBytes) / 1073741824,
    manualStorageUsedGiB: config.manualStorageUsedBytes == null ? null : Number(config.manualStorageUsedBytes) / 1073741824,
    trafficQuotaGiB: config.trafficQuotaBytes == null ? null : Number(config.trafficQuotaBytes) / 1073741824,
    manualTrafficUsedGiB: config.manualTrafficUsedBytes == null ? null : Number(config.manualTrafficUsedBytes) / 1073741824,
    autoFailover: config.autoFailover ?? false,
  });
  form.selectForProject = false;
  form.configValues = buildConfigValues(config.provider, config.config);
  resetDraftTest();
  dialogVisible.value = true;
}

const draftFingerprint = computed(() =>
  JSON.stringify({
    provider: form.provider,
    name: form.name,
    config: form.configValues,
    configId: editingConfig.value?.id ?? '',
  }),
);

const saveEnabled = computed(
  () =>
    Boolean(draftTestResult.value?.success) &&
    draftTestedKey.value === draftFingerprint.value &&
    !draftTesting.value,
);

/** Any edit invalidates the previous probe result. */
function resetDraftTest(): void {
  draftTestResult.value = null;
  draftTestedKey.value = '';
}

async function testDraftConfig(): Promise<void> {
  const valid = await formRef.value?.validate();
  if (!valid) {
    return;
  }

  const parsedConfig = collectConfigValues(
    form.provider,
    form.configValues,
    Boolean(editingConfig.value && editingConfig.value.provider === form.provider),
  );
  if (!parsedConfig) {
    return;
  }

  const fingerprint = draftFingerprint.value;
  draftTesting.value = true;
  try {
    const payload = { provider: form.provider, name: form.name, config: parsedConfig };
    const result = editingConfig.value
      ? await cdnApi.testDraftForConfig(editingConfig.value.id, payload, configProjectScope(editingConfig.value))
      : await cdnApi.testDraft(
          payload,
          selectedProjectId.value && canManageSelectedProject.value ? selectedProjectId.value : undefined,
        );

    draftTestResult.value = result;
    draftTestedKey.value = fingerprint;
    if (result.success) {
      ElMessage.success('连接测试通过，可以保存。');
    } else {
      ElMessage.error('连接测试未通过，请根据检查结果修正配置。');
    }
  } finally {
    draftTesting.value = false;
  }
}

async function submitConfig(): Promise<void> {
  if (!saveEnabled.value) {
    ElMessage.warning('请先完成“测试连接”并通过。');
    return;
  }
  const valid = await formRef.value?.validate();
  if (!valid) {
    return;
  }

  const parsedConfig = collectConfigValues(
    form.provider,
    form.configValues,
    Boolean(editingConfig.value && editingConfig.value.provider === form.provider),
  );
  if (!parsedConfig) {
    return;
  }

  submitting.value = true;
  try {
    if (editingConfig.value) {
      if (!canEditConfig(editingConfig.value)) {
        return;
      }

      const result = await cdnApi.update(editingConfig.value.id, {
        provider: form.provider,
        name: form.name,
        config: parsedConfig,
        priority: form.priority,
        failoverThresholdPercent: form.failoverThresholdPercent,
        autoFailover: form.autoFailover,
        storageQuotaBytes: form.storageQuotaGiB == null ? null : Math.round(form.storageQuotaGiB * 1073741824),
        manualStorageUsedBytes: form.manualStorageUsedGiB == null ? null : Math.round(form.manualStorageUsedGiB * 1073741824),
        trafficQuotaBytes: form.trafficQuotaGiB == null ? null : Math.round(form.trafficQuotaGiB * 1073741824),
        manualTrafficUsedBytes: form.manualTrafficUsedGiB == null ? null : Math.round(form.manualTrafficUsedGiB * 1073741824),
      }, configProjectScope(editingConfig.value));
      if (form.selectForProject && selectedProjectId.value) {
        await cdnApi.activate(selectedProjectId.value, result.id);
      }
      ElMessage.success('存储配置已更新。');
    } else {
      if (!canCreateConfig.value) {
        return;
      }

      const projectScope = selectedProjectId.value && canManageSelectedProject.value ? selectedProjectId.value : undefined;
      const result = await cdnApi.create({
        provider: form.provider,
        name: form.name,
        config: parsedConfig,
        priority: form.priority,
        failoverThresholdPercent: form.failoverThresholdPercent,
        autoFailover: form.autoFailover,
        storageQuotaBytes: form.storageQuotaGiB == null ? null : Math.round(form.storageQuotaGiB * 1073741824),
        manualStorageUsedBytes: form.manualStorageUsedGiB == null ? null : Math.round(form.manualStorageUsedGiB * 1073741824),
        trafficQuotaBytes: form.trafficQuotaGiB == null ? null : Math.round(form.trafficQuotaGiB * 1073741824),
        manualTrafficUsedBytes: form.manualTrafficUsedGiB == null ? null : Math.round(form.manualTrafficUsedGiB * 1073741824),
      }, projectScope);
      if (form.selectForProject && selectedProjectId.value) {
        await cdnApi.activate(selectedProjectId.value, result.id);
      }
      ElMessage.success('存储配置已创建。');
    }
    dialogVisible.value = false;
    await reload();
  } finally {
    submitting.value = false;
  }
}

function buildConfigValues(provider: CdnProvider, config: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(
    providerHelp[provider].fields.map((field) => [field.key, String(config[field.key] ?? '')]),
  );
}

function collectConfigValues(
  provider: CdnProvider,
  values: Record<string, string>,
  allowMaskedSecrets: boolean,
): Record<string, unknown> | null {
  const config: Record<string, unknown> = {};
  const maskedKeys = new Set<string>();

  for (const field of providerHelp[provider].fields) {
    const value = String(values[field.key] ?? '').trim();

    if (allowMaskedSecrets && field?.secret && value === MASKED_SECRET) {
      maskedKeys.add(field.key);
      continue;
    }

    config[field.key] = value;
  }

  const missingFields = providerHelp[provider].fields.filter((field) => {
    if (!field.required) {
      return false;
    }

    return !maskedKeys.has(field.key) && String(config[field.key] ?? '').trim() === '';
  });

  if (missingFields.length > 0) {
    ElMessage.error(`请填写：${missingFields.map((field) => field.label).join('、')}。`);
    return null;
  }

  return config;
}

async function activate(config: CdnConfig): Promise<void> {
  if (!selectedProjectId.value || !canManageSelectedProject.value) {
    return;
  }

  await cdnApi.activate(selectedProjectId.value, config.id);
  ElMessage.success('项目存储配置已切换。');
  await reload();
}

async function removeConfig(config: CdnConfig): Promise<void> {
  if (!canRemoveConfig(config)) {
    return;
  }

  await ElMessageBox.confirm('确认删除该存储配置？仍被项目使用的配置不能删除。', '删除配置', {
    type: 'warning',
    confirmButtonText: '确认删除',
    cancelButtonText: '取消',
  });
  await cdnApi.remove(config.id, configProjectScope(config));
  ElMessage.success('存储配置已删除。');
  await reload();
}

async function testConfig(config: CdnConfig): Promise<void> {
  testingConfigId.value = config.id;
  try {
    healthResult.value = await cdnApi.test(config.id, configProjectScope(config));
    if (healthResult.value.usage) {
      usageByConfigId.value = {
        ...usageByConfigId.value,
        [config.id]: healthResult.value.usage,
      };
    }
    healthDialogVisible.value = true;
  } finally {
    testingConfigId.value = '';
  }
}

onMounted(loadProjects);
</script>

<style scoped>
.data-table {
  margin-top: 14px;
}

.config-summary {
  color: #334155;
  font-size: 13px;
}

.usage-cell {
  font-size: 12px;
  line-height: 1.4;
  color: #0f172a;
}

.usage-sub {
  font-size: 11px;
}

.usage-panel {
  margin-top: 8px;
}

.usage-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 8px;
}

.usage-metric {
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.usage-value {
  margin-top: 4px;
  font-size: 18px;
  font-weight: 600;
  color: #0f172a;
}

.config-section {
  margin-bottom: 18px;
}

.config-section-title {
  margin-bottom: 8px;
  color: #0f172a;
  font-size: 14px;
  font-weight: 600;
}

.config-field-grid {
  display: grid;
  gap: 14px 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.config-field-item {
  margin-bottom: 0;
}

.field-help {
  width: 100%;
  margin-top: 6px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dialog-footer-right {
  display: flex;
  gap: 8px;
}

.draft-test-panel {
  margin-top: 8px;
}

.config-help {
  width: 100%;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-muted);
  color: #475569;
  font-size: 13px;
  line-height: 1.6;
}

.health-panel {
  display: grid;
  gap: 14px;
}

.health-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

@media (max-width: 760px) {
  .config-field-grid {
    grid-template-columns: 1fr;
  }
}
</style>

