<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">存储配置</h1>
        <p class="page-subtitle">统一维护存储账户，并分配给可使用这些存储的项目。</p>
      </div>
      <el-button
        v-if="canCreateConfig"
        type="primary"
        :icon="Plus"
        @click="openCreateDialog"
      >
        新建全局配置
      </el-button>
    </div>

    <section class="surface plugin-panel">
      <div class="surface-body">
        <div class="toolbar">
          <h2 class="section-title">存储插件</h2>
          <el-button v-if="canCreateConfig" :loading="installingPlugin" @click="pluginFileInput?.click()">上传插件 ZIP / 升级</el-button>
          <input ref="pluginFileInput" type="file" accept=".zip,application/zip" hidden @change="installPlugin" />
        </div>
        <p class="muted">本地存储由系统提供。其他存储需先上传安装插件，再创建存储配置。</p>
        <p class="muted">插件会在服务器运行代码，请仅安装你信任的开发者提供的插件包。</p>
        <el-alert v-if="pluginLoadError" type="error" :closable="false" :title="pluginLoadError" />
        <el-table :data="remotePlugins" row-key="id">
          <el-table-column prop="name" label="插件" min-width="170" />
          <el-table-column prop="id" label="标识" min-width="160" />
          <el-table-column prop="version" label="版本" width="110" />
          <el-table-column label="能力" min-width="230">
            <template #default="{ row }">
              <span>上传 / 下载 / 删除</span>
              <el-tag v-if="row.capabilities.directUpload" size="small">支持签名直传</el-tag>
              <el-tag v-if="row.capabilities.usage" size="small">平台用量</el-tag>
              <el-tag v-if="row.available === false" type="danger" size="small">加载失败</el-tag>
              <div v-if="row.error" class="field-help">{{ row.error }}</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="190">
            <template #default="{ row }">
              <el-button link type="primary" @click="downloadPlugin(row)">下载包</el-button>
              <el-button v-if="canCreateConfig" link type="danger" :loading="removingPluginId === row.id" :disabled="isPluginReferenced(row.id)" @click="removePlugin(row)">卸载</el-button>
              <span v-if="isPluginReferenced(row.id)" class="muted">配置引用中</span>
            </template>
          </el-table-column>
          <template #empty>尚未安装远程存储插件</template>
        </el-table>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar">
          <el-button :icon="Refresh" @click="reload">刷新</el-button>
        </div>

        <el-table v-loading="loading" :data="configs" row-key="id" class="data-table">
          <el-table-column prop="name" label="配置名称" min-width="180" />
          <el-table-column prop="provider" label="平台" width="120">
            <template #default="{ row }">
              <el-tag>{{ providerLabel(row.provider) }}</el-tag>
              <el-tag v-if="!pluginFor(row.provider)" type="danger" size="small">插件未安装</el-tag>
              <el-tag v-else-if="pluginFor(row.provider)?.available === false" type="danger" size="small">插件不可用</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="可使用项目" min-width="220">
            <template #default="{ row }">
              <div v-if="row.projects?.length" class="assigned-project-tags">
                <el-tag v-for="project in row.projects" :key="project.id" :type="project.current ? 'success' : 'info'">
                  {{ project.name }}{{ project.current ? ' · 当前' : '' }}
                </el-tag>
              </div>
              <span v-else class="muted">未分配项目</span>
            </template>
          </el-table-column>
          <el-table-column label="配置状态" width="110">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '可用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="配置摘要" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="config-summary">{{ summarizeConfig(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="限额与余额" min-width="255">
            <template #default="{ row }">
              <span v-if="row.provider === 'LOCAL'" class="muted">本地兜底</span>
              <div v-else class="usage-cell">
                <div>空间限制：{{ row.storageLimitEnabled ? '启用' : '停用' }}<span v-if="row.storageLimitEnabled"> · {{ row.failoverThresholdPercent }}% 暂停上传</span></div>
                <div v-if="spaceState(row).quota != null">有效空间 {{ formatBytes(spaceState(row).used) }} / {{ formatBytes(spaceState(row).quota) }}</div>
                <el-tag v-if="spaceState(row).paused" size="small" type="warning">{{ spaceState(row).unknown ? '空间用量未知，暂停上传' : '空间已达阈值，暂停上传' }}</el-tag>
                <template v-if="row.trafficLimitEnabled">
                  <div>{{ row.trafficQuotaMode === 'MONTHLY' ? '每月额度' : '固定额度' }}：{{ formatBytes(Number(row.trafficQuotaBytes)) }}</div>
                  <div>已用 {{ formatBytes(Number(row.trafficUsedBytes)) }} · 剩余 {{ formatBytes(Number(row.trafficRemainingBytes)) }}</div>
                  <el-tag v-if="row.trafficExhausted" size="small" type="danger">流量不足，暂停上传和下载</el-tag>
                  <span v-else-if="row.trafficQuotaMode === 'MONTHLY'" class="muted">{{ row.trafficPeriodKey }} · 每月 1 日重置</span>
                </template>
                <span v-else class="muted">流量限制：停用</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="平台用量 / 空间基准" min-width="220">
            <template #default="{ row }">
              <div v-if="supportsUsage(row.provider) || row.storageQuotaBytes != null || row.manualStorageUsedBytes != null || row.trafficQuotaBytes != null || row.manualTrafficUsedBytes != null" class="usage-cell">
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
                    <div v-if="usageByConfigId[row.id]?.trafficUsedSource === 'provider'" class="muted usage-sub">
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
                  v-if="supportsUsage(row.provider)"
                  link
                  type="primary"
                  :loading="usageLoadingId === row.id"
                  @click="loadUsage(row, true)"
                >
                  刷新用量
                </el-button>
                <el-button
                  v-if="authStore.isSuperAdmin"
                  link
                  type="primary"
                  @click="openAssignmentDialog(row)"
                >
                  分配项目
                </el-button>
                <el-button v-if="authStore.isSuperAdmin" link type="primary" @click="openEditDialog(row)">编辑</el-button>
                <el-button
                  v-if="authStore.isSuperAdmin"
                  link
                  type="danger"
                  :disabled="row.active"
                  @click="removeConfig(row)"
                >
                  删除
                </el-button>
                <span v-if="!authStore.isSuperAdmin" class="muted">-</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <el-dialog v-model="dialogVisible" :title="editingConfig ? '编辑存储配置' : '新建存储配置'" width="680px">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="平台" prop="provider">
          <el-select v-model="form.provider" :disabled="Boolean(editingConfig)" style="width: 100%" @change="fillTemplate">
            <el-option v-for="option in providerOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="配置名称" prop="name">
          <el-input v-model="form.name" maxlength="128" show-word-limit />
        </el-form-item>
        <div class="config-section">
          <div class="config-section-title">平台配置</div>
          <el-alert v-if="!pluginFor(form.provider) || pluginFor(form.provider)?.available === false" type="warning" :closable="false" title="此存储插件未安装或加载失败。请上传匹配的插件后测试连接；已有配置参数保留。" />
          <div class="config-field-grid">
            <el-form-item
              v-for="field in currentHelp.fields"
              :key="field.key"
              :label="field.label"
              :required="field.required"
              class="config-field-item"
            >
              <el-switch v-if="field.type === 'boolean'" v-model="form.configValues[field.key]" />
              <el-input-number v-else-if="field.type === 'number'" :model-value="form.configValues[field.key] === undefined ? undefined : Number(form.configValues[field.key])" @update:model-value="form.configValues[field.key] = $event" />
              <el-select v-else-if="field.type === 'select'" v-model="form.configValues[field.key]" clearable>
                <el-option v-for="option in field.options" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-input
                v-else
                :model-value="String(form.configValues[field.key] ?? '')"
                :type="field.secret ? 'password' : 'text'"
                :show-password="field.secret"
                :placeholder="field.placeholder"
                autocomplete="off"
                @update:model-value="form.configValues[field.key] = $event"
              />
              <div v-if="field.description" class="field-help">{{ field.description }}</div>
            </el-form-item>
          </div>
          <div class="config-help">{{ currentHelp.description }}</div>
        </div>
        <div v-if="form.provider !== 'LOCAL'" class="config-section">
          <div class="config-section-title">容量与流量限额</div>
          <div class="config-field-grid">
            <el-form-item label="优先级（数字越小越优先）"><el-input-number v-model="form.priority" :min="0" :max="100000" /></el-form-item>
            <el-form-item label="启用空间限制"><el-switch v-model="form.storageLimitEnabled" /></el-form-item>
            <el-form-item label="暂停上传阈值 (%)"><el-input-number v-model="form.failoverThresholdPercent" :disabled="!form.storageLimitEnabled" :min="1" :max="100" /></el-form-item>
            <el-form-item label="空间上限 (GiB)"><el-input-number v-model="form.storageQuotaGiB" :min="0" :max="8388607" :precision="6" clearable :value-on-clear="null" /></el-form-item>
            <el-form-item label="手动已用空间基准 (GiB)"><el-input-number v-model="form.manualStorageUsedGiB" :min="0" :max="8388607" :precision="6" clearable :value-on-clear="null" /></el-form-item>
            <el-form-item label="启用流量限制"><el-switch v-model="form.trafficLimitEnabled" /></el-form-item>
            <el-form-item label="流量额度模式"><el-segmented v-model="form.trafficQuotaMode" :options="[{ label: '每月重置', value: 'MONTHLY' }, { label: '固定额度', value: 'FIXED' }]" /></el-form-item>
            <el-form-item :label="form.trafficQuotaMode === 'MONTHLY' ? '每月流量额度 (GiB)' : '固定流量额度 (GiB)'" :required="form.trafficLimitEnabled"><el-input-number v-model="form.trafficQuotaGiB" :min="0" :max="8388607" :precision="6" clearable :value-on-clear="null" /></el-form-item>
            <el-form-item label="已用流量校正 (GiB)"><el-input-number v-model="form.manualTrafficUsedGiB" :min="0" :max="8388607" :precision="6" clearable :value-on-clear="null" /></el-form-item>
          </div>
          <el-checkbox v-model="form.autoFailover">达到阈值后自动切换新上传目标</el-checkbox>
          <div class="field-help">空间基准优先使用手动值，未填写时取平台回报，并计入后续上传。达到阈值或空间不足时暂停云上传，文件保存在本地兜底。</div>
          <div class="field-help">{{ form.trafficQuotaMode === 'MONTHLY' ? '每月 1 日北京时间 00:00 重置已用流量。' : '固定额度不自动重置，可手动调整总额或已用量。' }} 流量不足时暂停该存储上传和下载，自动尝试其他存储或本地。关闭限制停止扣减并保留计数。</div>
          <div class="field-help">启用后按本系统实际从云端读取的字节扣减，包含下载、同步和完整性校验；分段下载可能先读取整个文件进行校验，不等同于云平台账单。未修改已用量时，保存会保留期间新增的计数。</div>
        </div>
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
          <el-button :icon="Connection" :loading="draftTesting" :disabled="!pluginFor(form.provider) || pluginFor(form.provider)?.available === false" @click="testDraftConfig">测试连接</el-button>
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

    <el-dialog v-model="assignmentDialogVisible" title="分配项目" width="560px">
      <div v-loading="assignmentLoading" class="assignment-panel">
        <p class="assignment-description">选择可使用「{{ assignmentConfig?.name }}」的项目。一个项目可以使用多个存储，当前上传存储在项目详情中选择。</p>
        <el-checkbox-group v-model="assignedProjectIds" class="assignment-projects" :disabled="assignmentLoading || assignmentSubmitting">
          <el-checkbox v-for="project in projects" :key="project.id" :value="project.id">
            {{ project.name }}
            <el-tag v-if="currentAssignmentProjectIds.includes(project.id)" size="small" type="success">当前存储</el-tag>
          </el-checkbox>
        </el-checkbox-group>
        <el-empty v-if="!assignmentLoading && projects.length === 0" description="暂无可分配的项目" :image-size="64" />
      </div>
      <template #footer>
        <el-button :disabled="assignmentSubmitting" @click="assignmentDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="assignmentSubmitting" :disabled="assignmentLoading" @click="saveAssignments">保存</el-button>
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

import { cdnApi, projectApi } from '@/api/modules';
import { storagePluginsApi, type StoragePluginManifest } from '@/api/storage-plugins';
import { useAuthStore } from '@/stores/auth';
import type { CdnConfig, CdnProvider, Project, StorageHealthResult, StorageUsageResult } from '@/types';
import { limitFormValues, storageLimitPayload, storageSpaceView } from '@/utils/storage-limit-form';
import { buildPluginConfigValues, collectPluginConfigValues, type PluginConfigValue } from '@/utils/storage-plugin-form';

const authStore = useAuthStore();
async function downloadPlugin(plugin: StoragePluginManifest): Promise<void> {
  const blob = await storagePluginsApi.download(plugin.id);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `${plugin.id}-${plugin.version}.zip`;
  anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const loading = ref(false);
const submitting = ref(false);
const testingConfigId = ref('');
const usageLoadingId = ref('');
const usageByConfigId = ref<Record<string, StorageUsageResult>>({});
const projects = ref<Project[]>([]);
const configs = ref<CdnConfig[]>([]);
const healthDialogVisible = ref(false);
const healthResult = ref<StorageHealthResult | null>(null);
const canCreateConfig = computed(() => authStore.isSuperAdmin);
const assignmentDialogVisible = ref(false);
const assignmentLoading = ref(false);
const assignmentSubmitting = ref(false);
const assignmentConfig = ref<CdnConfig | null>(null);
const assignedProjectIds = ref<string[]>([]);
const currentAssignmentProjectIds = ref<string[]>([]);
const dialogVisible = ref(false);
const editingConfig = ref<CdnConfig | null>(null);
const draftTesting = ref(false);
const draftTestResult = ref<StorageHealthResult | null>(null);
/** Fingerprint of the tested payload; any field change invalidates the result. */
const draftTestedKey = ref('');
const initialConnectionKey = ref('');
const initialLimitValues = ref<ReturnType<typeof limitFormValues>>();
const formRef = ref<FormInstance>();
const localPlugin: StoragePluginManifest = {
  id: 'LOCAL', name: '本地', version: '1', apiVersion: 1, builtin: true, capabilities: {},
  description: '本地存储需要保存目录和对外访问域名。',
  fields: [
    { key: 'root', label: '保存目录', type: 'string', required: true, placeholder: './storage' },
    { key: 'domain', label: '访问域名', type: 'string', required: true, url: true, placeholder: 'http://localhost:60557' },
  ],
};
const plugins = ref<StoragePluginManifest[]>([localPlugin]);
const pluginLoadError = ref('');
const installingPlugin = ref(false);
const removingPluginId = ref('');
const pluginFileInput = ref<HTMLInputElement>();
const remotePlugins = computed(() => plugins.value.filter(plugin => plugin.id !== 'LOCAL'));
const providerOptions = computed(() => {
  const options = plugins.value.filter(plugin => plugin.available !== false).map(plugin => ({ label: plugin.name, value: plugin.id }));
  if (editingConfig.value && !options.some(option => option.value === editingConfig.value?.provider)) {
    options.push({ label: `${editingConfig.value.provider}（插件未安装）`, value: editingConfig.value.provider });
  }
  return options;
});
const form = reactive({
  provider: 'LOCAL' as CdnProvider,
  name: '',
  configValues: {} as Record<string, PluginConfigValue>,
  priority: 100,
  failoverThresholdPercent: 90,
  ...limitFormValues({}),
  autoFailover: false,
});
const rules: FormRules = {
  provider: [{ required: true, message: '请选择存储平台。', trigger: 'change' }],
  name: [{ required: true, message: '请输入配置名称。', trigger: 'blur' }],
};
const currentHelp = computed(() => pluginFor(form.provider) ?? { description: '', fields: [] });

function pluginFor(provider: CdnProvider): StoragePluginManifest | undefined {
  return plugins.value.find(plugin => plugin.id === provider);
}

function supportsUsage(provider: CdnProvider): boolean {
  return pluginFor(provider)?.available !== false && Boolean(pluginFor(provider)?.capabilities.usage);
}

function providerLabel(provider: CdnProvider): string {
  const option = providerOptions.value.find((item) => item.value === provider);
  return option?.label || provider;
}

function spaceState(config: CdnConfig) {
  return storageSpaceView(config, usageByConfigId.value[config.id]);
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
  const plugin = pluginFor(config.provider);
  if (!plugin) return '请安装匹配的存储插件以查看和测试配置';
  const fields = plugin.fields;
  const parts = fields
    .filter((field) => !field.secret && config.config[field.key] !== undefined && config.config[field.key] !== '')
    .map((field) => `${field.label}=${String(config.config[field.key])}`);

  return parts.length > 0 ? parts.join(' / ') : '未填写';
}

function fillTemplate(): void {
  const source = editingConfig.value?.provider === form.provider ? editingConfig.value.config : {};
  form.configValues = buildConfigValues(form.provider, source);
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    await Promise.all([loadPlugins(), cdnApi.list().then(result => { configs.value = result; })]);
    void loadUsageForCloudConfigs();
  } finally {
    loading.value = false;
  }
}

async function loadPlugins(): Promise<void> {
  try {
    const result = await storagePluginsApi.list();
    plugins.value = result.some(plugin => plugin.id === 'LOCAL') ? result : [localPlugin, ...result];
    pluginLoadError.value = '';
  } catch {
    pluginLoadError.value = '插件列表加载失败，请刷新后重试。';
  }
}

function isPluginReferenced(id: string): boolean {
  return configs.value.some(config => config.provider === id) || Boolean(pluginFor(id)?.configCount);
}

async function installPlugin(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !canCreateConfig.value) return;
  if (!file.name.toLowerCase().endsWith('.zip')) { ElMessage.error('请选择插件 ZIP 文件。'); return; }
  installingPlugin.value = true;
  try {
    const result = await storagePluginsApi.install(file);
    ElMessage.success(`${result.name} ${result.version} 已安装。`);
    await reload();
  } finally { installingPlugin.value = false; }
}

async function removePlugin(plugin: StoragePluginManifest): Promise<void> {
  if (!canCreateConfig.value || plugin.id === 'LOCAL' || isPluginReferenced(plugin.id)) return;
  try {
    await ElMessageBox.confirm(`确认卸载「${plugin.name}」？以后可重新上传插件包安装。`, '卸载存储插件', { type: 'warning', confirmButtonText: '卸载', cancelButtonText: '取消' });
  } catch { return; }
  removingPluginId.value = plugin.id;
  try {
    await storagePluginsApi.remove(plugin.id);
    ElMessage.success('存储插件已卸载。');
    await reload();
  } finally { removingPluginId.value = ''; }
}

async function loadUsage(config: CdnConfig, force = false): Promise<void> {
  if (!supportsUsage(config.provider)) {
    return;
  }
  if (!force && usageByConfigId.value[config.id]) {
    return;
  }
  usageLoadingId.value = config.id;
  try {
    const usage = await cdnApi.usage(config.id);
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
  const cloud = configs.value.filter((item) => supportsUsage(item.provider));
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
  form.provider = 'LOCAL';
  form.name = '';
  Object.assign(form, { priority: 100, failoverThresholdPercent: 90, ...limitFormValues({}), autoFailover: false });
  initialLimitValues.value = undefined;
  initialConnectionKey.value = '';
  form.configValues = buildConfigValues(form.provider);
  resetDraftTest();
  dialogVisible.value = true;
}

function openEditDialog(config: CdnConfig): void {
  if (!authStore.isSuperAdmin) {
    return;
  }

  editingConfig.value = config;
  form.provider = config.provider;
  form.name = config.name;
  Object.assign(form, {
    priority: config.priority ?? 100,
    failoverThresholdPercent: config.failoverThresholdPercent ?? 90,
    ...limitFormValues(config),
    autoFailover: config.autoFailover ?? false,
  });
  form.configValues = buildConfigValues(config.provider, config.config);
  initialConnectionKey.value = connectionFingerprint.value;
  initialLimitValues.value = limitFormValues(config);
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

const connectionFingerprint = computed(() => JSON.stringify({ provider: form.provider, config: form.configValues }));
const connectionUnchanged = computed(() => Boolean(editingConfig.value) && connectionFingerprint.value === initialConnectionKey.value);
const saveEnabled = computed(
  () =>
    (connectionUnchanged.value || (Boolean(draftTestResult.value?.success) &&
    draftTestedKey.value === draftFingerprint.value)) &&
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
      ? await cdnApi.testDraftForConfig(editingConfig.value.id, payload)
      : await cdnApi.testDraft(payload);

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
    if (form.trafficLimitEnabled && form.trafficQuotaGiB == null) {
      ElMessage.warning('启用流量限制时请填写流量额度。');
      return;
    }
    const policy = { priority: form.priority, failoverThresholdPercent: form.failoverThresholdPercent,
      autoFailover: form.autoFailover, ...storageLimitPayload(form, initialLimitValues.value) };
    if (editingConfig.value) {
      if (!authStore.isSuperAdmin) {
        return;
      }

      await cdnApi.update(editingConfig.value.id, {
        ...(connectionUnchanged.value ? {} : { provider: form.provider, config: parsedConfig }),
        name: form.name,
        ...policy,
      });
      ElMessage.success('存储配置已更新。');
    } else {
      if (!canCreateConfig.value) {
        return;
      }

      await cdnApi.create({
        provider: form.provider,
        name: form.name,
        config: parsedConfig,
        ...policy,
      });
      ElMessage.success('存储配置已创建。');
    }
    dialogVisible.value = false;
    await reload();
  } finally {
    submitting.value = false;
  }
}

function buildConfigValues(provider: CdnProvider, config: Record<string, unknown> = {}): Record<string, PluginConfigValue> {
  return buildPluginConfigValues(pluginFor(provider)?.fields ?? [], config);
}

function collectConfigValues(
  provider: CdnProvider,
  values: Record<string, PluginConfigValue>,
  allowMaskedSecrets: boolean,
): Record<string, unknown> | null {
  const plugin = pluginFor(provider);
  if (!plugin) {
    if (connectionUnchanged.value) return {};
    ElMessage.error('请先安装匹配的存储插件。');
    return null;
  }
  try { return collectPluginConfigValues(plugin.fields, values, allowMaskedSecrets); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : '存储配置无效。'); return null; }
}

async function openAssignmentDialog(config: CdnConfig): Promise<void> {
  if (!authStore.isSuperAdmin) {
    return;
  }
  assignmentConfig.value = config;
  assignedProjectIds.value = [];
  currentAssignmentProjectIds.value = [];
  assignmentDialogVisible.value = true;
  assignmentLoading.value = true;
  try {
    const [allProjects, bindings] = await Promise.all([projectApi.list(), cdnApi.projects(config.id)]);
    projects.value = allProjects;
    assignedProjectIds.value = bindings.map((project) => project.id);
    currentAssignmentProjectIds.value = bindings.filter((project) => project.current).map((project) => project.id);
  } catch {
    assignmentDialogVisible.value = false;
  } finally {
    assignmentLoading.value = false;
  }
}

async function saveAssignments(): Promise<void> {
  if (!assignmentConfig.value || !authStore.isSuperAdmin || assignmentLoading.value) {
    return;
  }
  assignmentSubmitting.value = true;
  try {
    const bindings = await cdnApi.assignProjects(assignmentConfig.value.id, assignedProjectIds.value);
    assignmentConfig.value.projects = bindings;
    assignmentConfig.value.active = bindings.some((project) => project.current);
    assignmentDialogVisible.value = false;
    ElMessage.success('项目分配已保存。');
  } catch {
    // The HTTP client displays the server reason; keep the choices available to revise.
  } finally {
    assignmentSubmitting.value = false;
  }
}

async function removeConfig(config: CdnConfig): Promise<void> {
  if (!authStore.isSuperAdmin) {
    return;
  }

  await ElMessageBox.confirm('确认删除该存储配置？仍被项目使用的配置不能删除。', '删除配置', {
    type: 'warning',
    confirmButtonText: '确认删除',
    cancelButtonText: '取消',
  });
  await cdnApi.remove(config.id);
  ElMessage.success('存储配置已删除。');
  await reload();
}

async function testConfig(config: CdnConfig): Promise<void> {
  testingConfigId.value = config.id;
  try {
    healthResult.value = await cdnApi.test(config.id);
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

onMounted(reload);
</script>

<style scoped>
.plugin-panel { margin-bottom: 20px; }
.data-table {
  margin-top: 14px;
}

.assigned-project-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.assignment-description {
  margin-top: 0;
  color: #64748b;
  line-height: 1.6;
}

.assignment-projects {
  display: grid;
  gap: 8px;
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

