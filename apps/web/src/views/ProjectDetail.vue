<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ project?.name || '项目详情' }}</h1>
        <p class="page-subtitle">{{ project?.description || '查看项目凭证、存储状态和近期文件。' }}</p>
      </div>
      <div class="toolbar">
        <input ref="importInputRef" type="file" accept="application/json,.json" class="hidden-input" @change="importProject" />
        <el-button :icon="Back" @click="$router.push('/projects')">返回项目</el-button>
        <el-button v-if="project?.canManage" :icon="Download" @click="exportProject">导出项目</el-button>
        <el-button v-if="project?.canManage" :icon="UploadFilled" @click="importInputRef?.click()">导入项目</el-button>
        <el-button type="primary" :icon="Upload" @click="$router.push({ path: '/files', query: { projectId } })">
          管理文件
        </el-button>
      </div>
    </div>

    <section class="metric-grid">
      <div class="metric">
        <div class="metric-label">AppID</div>
        <div class="metric-value mono small-value">{{ project?.appId }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">总容量</div>
        <div class="metric-value">{{ formatSize(stats?.totalSize || 0) }}</div>
        <div v-if="stats?.quotaBytes" class="metric-sub">
          配额 {{ formatSize(stats.quotaBytes) }} · {{ stats.bytesUsagePercent ?? 0 }}%
          <el-progress
            :percentage="Math.min(100, stats.bytesUsagePercent || 0)"
            :stroke-width="8"
            :show-text="false"
            style="margin-top: 6px"
          />
        </div>
      </div>
      <div class="metric">
        <div class="metric-label">文件数量</div>
        <div class="metric-value">{{ stats?.fileCount ?? project?.fileCount ?? 0 }}</div>
        <div v-if="stats?.quotaFiles" class="metric-sub">
          配额 {{ stats.quotaFiles }} · {{ stats.filesUsagePercent ?? 0 }}%
          <el-progress
            :percentage="Math.min(100, stats.filesUsagePercent || 0)"
            :stroke-width="8"
            :show-text="false"
            style="margin-top: 6px"
          />
        </div>
      </div>
      <div class="metric">
        <div class="metric-label">重复文件</div>
        <div class="metric-value">{{ stats?.duplicateCount || 0 }}</div>
      </div>
      <div v-if="activeCloudUsage" class="metric">
        <div class="metric-label">当前云存储 · {{ activeCloudUsage.provider }}</div>
        <div class="metric-value">{{ formatSize(activeCloudUsage.storageUsedBytes || 0) }}</div>
        <div class="metric-sub">
          <template v-if="activeCloudUsage.storageQuotaBytes != null">
            配额 {{ formatSize(activeCloudUsage.storageQuotaBytes) }}
          </template>
          <template v-else>空间用量</template>
          <span v-if="activeCloudUsage.trafficUsedBytes != null">
            · 本月流量 {{ formatSize(activeCloudUsage.trafficUsedBytes) }}
          </span>
        </div>
        <div v-if="activeCloudUsage.message" class="metric-sub muted">{{ activeCloudUsage.message }}</div>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">下载流量统计（近 {{ downloadDays }} 日）</div>
            <div class="muted">统计所有下载入口：后台、开放 API、公开访问、分享与 WebDAV。</div>
          </div>
          <el-select v-model="downloadDays" size="small" style="width: 130px" @change="loadDownloadStats">
            <el-option :value="1" label="近 1 日" />
            <el-option :value="7" label="近 7 日" />
            <el-option :value="30" label="近 30 日" />
            <el-option :value="90" label="近 90 日" />
          </el-select>
        </div>

        <div class="metric-grid">
          <div class="metric">
            <div class="metric-label">下载流量</div>
            <div class="metric-value">{{ formatSize(downloadSummary?.totalBytes || 0) }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">下载次数</div>
            <div class="metric-value">{{ downloadSummary?.totalCount || 0 }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">成功 / 失败</div>
            <div class="metric-value small-value">
              {{ downloadSummary?.successCount || 0 }} / {{ downloadSummary?.failedCount || 0 }}
            </div>
          </div>
        </div>

        <el-row :gutter="16" style="margin-top: 12px">
          <el-col :xs="24" :md="12">
            <div class="muted" style="margin-bottom: 8px">按来源统计</div>
            <el-table :data="downloadSummary?.bySource || []" size="small" empty-text="暂无下载数据">
              <el-table-column label="来源" min-width="120">
                <template #default="{ row }">{{ sourceLabel(row.source) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="次数" width="90" />
              <el-table-column label="流量" width="130">
                <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
              </el-table-column>
            </el-table>
          </el-col>
          <el-col :xs="24" :md="12">
            <div class="muted" style="margin-bottom: 8px">下载最多的文件</div>
            <el-table :data="downloadSummary?.byFile || []" size="small" empty-text="暂无下载数据">
              <el-table-column label="文件" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">{{ row.originalName || row.fileId || '-' }}</template>
              </el-table-column>
              <el-table-column prop="count" label="次数" width="90" />
              <el-table-column label="流量" width="130">
                <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
              </el-table-column>
            </el-table>
          </el-col>
        </el-row>

        <div class="muted" style="margin: 16px 0 8px">最近下载明细</div>
        <el-table v-loading="downloadLoading" :data="downloadItems" size="small" empty-text="暂无下载记录">
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="文件" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ row.originalName || row.fileId || '-' }}</template>
          </el-table-column>
          <el-table-column label="来源" width="110">
            <template #default="{ row }">{{ sourceLabel(row.source) }}</template>
          </el-table-column>
          <el-table-column label="流量" width="110">
            <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
          </el-table-column>
          <el-table-column prop="ip" label="IP" min-width="130" show-overflow-tooltip />
          <el-table-column label="结果" width="80">
            <template #default="{ row }">
              <el-tag :type="row.success ? 'success' : 'danger'" size="small">
                {{ row.success ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          v-if="downloadTotal > downloadPageSize"
          v-model:current-page="downloadPage"
          :page-size="downloadPageSize"
          :total="downloadTotal"
          layout="prev, pager, next"
          style="margin-top: 12px"
          @current-change="loadDownloadStats"
        />
      </div>
    </section>

    <section v-if="stats?.uploadTrend?.length" class="surface">
      <div class="surface-body">
        <div class="section-title">近 30 日上传趋势</div>
        <div class="trend-bars">
          <div v-for="item in stats.uploadTrend" :key="item.date" class="trend-bar" :title="`${item.date}: ${item.count} 个 / ${formatSize(item.size)}`">
            <div class="trend-fill" :style="{ height: `${trendHeight(item.count)}%` }" />
            <div class="trend-label">{{ item.date.slice(5) }}</div>
          </div>
        </div>
      </div>
    </section>

    <section v-if="stats?.topFilesBySize?.length" class="surface">
      <div class="surface-body">
        <div class="section-title">体积 Top 文件</div>
        <el-table :data="stats.topFilesBySize" row-key="id" size="small">
          <el-table-column prop="originalName" label="文件名" min-width="220" show-overflow-tooltip />
          <el-table-column label="目录" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.folderPath || '/' }}</template>
          </el-table-column>
          <el-table-column prop="category" label="类型" width="100" />
          <el-table-column label="大小" width="120">
            <template #default="{ row }">{{ formatSize(row.size) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div class="section-title">公开访问热点（近 {{ hotspots?.days || 7 }} 日）</div>
          <el-select v-model="hotspotDays" size="small" style="width: 120px" @change="loadHotspots">
            <el-option :value="1" label="近 1 日" />
            <el-option :value="7" label="近 7 日" />
            <el-option :value="30" label="近 30 日" />
          </el-select>
        </div>
        <el-row :gutter="16">
          <el-col :xs="24" :md="12">
            <div class="muted" style="margin-bottom: 8px">按来源域名（Referer）</div>
            <el-table v-loading="hotspotsLoading" :data="hotspots?.byReferer || []" size="small" empty-text="暂无公开访问数据">
              <el-table-column prop="refererHost" label="来源" min-width="160" show-overflow-tooltip />
              <el-table-column prop="hits" label="次数" width="90" />
              <el-table-column label="流量" width="120">
                <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
              </el-table-column>
            </el-table>
          </el-col>
          <el-col :xs="24" :md="12">
            <div class="muted" style="margin-bottom: 8px">按文件</div>
            <el-table v-loading="hotspotsLoading" :data="hotspots?.byFile || []" size="small" empty-text="暂无公开访问数据">
              <el-table-column label="文件" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">{{ row.originalName || row.fileId || '-' }}</template>
              </el-table-column>
              <el-table-column prop="hits" label="次数" width="90" />
              <el-table-column label="流量" width="120">
                <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
              </el-table-column>
            </el-table>
          </el-col>
        </el-row>
      </div>
    </section>

    <section class="metric-grid">
      <div class="metric">
        <div class="metric-label">当前存储</div>
        <div class="metric-value small-value">{{ project?.activeCdnName || '未配置' }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">分享链接</div>
        <div class="metric-value">{{ stats?.shareLinkCount || 0 }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">有效密钥</div>
        <div class="metric-value">{{ stats?.activeSecretCount || 0 }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">公开文件域名</div>
        <div class="metric-value small-value">{{ formatDomains(project?.allowedDomains) }}</div>
      </div>
    </section>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div class="section-title">项目密钥</div>
          <el-button type="primary" :icon="Key" @click="createSecret">新增密钥</el-button>
        </div>
        <el-table :data="secrets" row-key="id">
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '有效' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="最近使用" min-width="170">
            <template #default="{ row }">{{ formatTime(row.lastUsedAt) }}</template>
          </el-table-column>
          <el-table-column label="创建时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button v-if="row.enabled" link type="danger" @click="disableSecret(row.id)">停用</el-button>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">存储配置</div>
            <div class="muted">当前项目可选择全局配置，也可以使用项目自己的存储配置。</div>
          </div>
          <el-button :icon="Connection" @click="$router.push({ path: '/storage-configs', query: { projectId } })">
            {{ project?.canManage ? '选择存储' : '查看存储' }}
          </el-button>
        </div>
        <el-table :data="cdnConfigs" row-key="id">
          <el-table-column prop="name" label="配置名称" min-width="180" />
          <el-table-column prop="provider" label="平台" width="120" />
          <el-table-column label="范围" width="110">
            <template #default="{ row }">
              <el-tag :type="row.projectId ? 'success' : 'info'">{{ row.projectId ? '项目' : '全局' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'">{{ row.active ? '生效' : '备用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="云用量" min-width="180">
            <template #default="{ row }">
              <template v-if="row.active && activeCloudUsage && activeCloudUsage.configId === row.id">
                {{ formatSize(activeCloudUsage.storageUsedBytes || 0) }}
                <span v-if="activeCloudUsage.trafficUsedBytes != null" class="muted">
                  · 流 {{ formatSize(activeCloudUsage.trafficUsedBytes) }}
                </span>
              </template>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="更新时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">存储迁移</div>
            <div class="muted">把仍挂在源配置上的文件对象迁移到目标配置，任务中心可查看进度。</div>
          </div>
        </div>
        <el-form label-position="top" class="migrate-form">
          <el-form-item label="源存储配置">
            <el-select v-model="migrateForm.sourceCdnConfigId" filterable class="full-input">
              <el-option v-for="item in cdnConfigs" :key="item.id" :label="`${item.name} (${item.provider})`" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="目标存储配置">
            <el-select v-model="migrateForm.targetCdnConfigId" filterable class="full-input">
              <el-option v-for="item in cdnConfigs" :key="item.id" :label="`${item.name} (${item.provider})`" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="migrateForm.deleteSource">迁移成功后尝试删除源对象</el-checkbox>
          </el-form-item>
          <el-button type="primary" :loading="migrateLoading" @click="startMigrate">开始迁移</el-button>
        </el-form>
      </div>
    </section>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">生命周期策略</div>
            <div class="muted">按目录/类型对过期文件自动回收或标记清理。</div>
          </div>
          <el-button type="primary" @click="openCreateLifecycle">新建策略</el-button>
        </div>
        <el-table v-loading="lifecycleLoading" :data="lifecyclePolicies" row-key="id">
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column label="目录" min-width="120">
            <template #default="{ row }">{{ row.folderPath || '/' }}</template>
          </el-table-column>
          <el-table-column prop="ttlDays" label="TTL(天)" width="90" />
          <el-table-column prop="action" label="动作" width="100" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160">
            <template #default="{ row }">
              <el-button link type="primary" @click="runLifecycle(row.id)">执行</el-button>
              <el-button link type="danger" @click="removeLifecycle(row.id)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">上传凭证</div>
            <div class="muted">用于客户端直传（Authorization: Upload &lt;token&gt;）。Token 仅创建时展示一次。</div>
          </div>
          <el-button type="primary" @click="openCreateCredential">新建凭证</el-button>
        </div>
        <el-table v-loading="credentialsLoading" :data="uploadCredentials" row-key="id">
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column prop="tokenPrefix" label="前缀" width="120" />
          <el-table-column label="用量" min-width="160">
            <template #default="{ row }">
              {{ formatSize(row.usedBytes || 0) }}
              <span v-if="row.maxBytes"> / {{ formatSize(row.maxBytes) }}</span>
              · {{ row.usedFiles || 0 }}
              <span v-if="row.maxFiles"> / {{ row.maxFiles }}</span> 个
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="过期" min-width="160">
            <template #default="{ row }">{{ formatTime(row.expiresAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'ACTIVE'"
                link
                type="danger"
                @click="revokeCredential(row.id)"
              >
                吊销
              </el-button>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div class="section-title">最近文件</div>
        </div>
        <el-table :data="files" row-key="id">
          <el-table-column prop="originalName" label="文件名" min-width="220" show-overflow-tooltip />
          <el-table-column prop="folderPath" label="目录" min-width="140">
            <template #default="{ row }">{{ row.folderPath || '/' }}</template>
          </el-table-column>
          <el-table-column prop="category" label="类型" width="120" />
          <el-table-column label="大小" width="120">
            <template #default="{ row }">{{ formatSize(row.size) }}</template>
          </el-table-column>
          <el-table-column label="上传时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <el-dialog v-model="secretDialogVisible" title="项目密钥" width="560px">
      <el-alert type="warning" show-icon :closable="false" title="AppSecret 仅展示本次，关闭后无法再次查看。" />
      <div class="secret-box">
        <div>
          <span class="muted">AppID</span>
          <div class="mono">{{ project?.appId }}</div>
        </div>
        <div>
          <span class="muted">AppSecret</span>
          <div class="mono secret-value">{{ latestSecret }}</div>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="credentialTokenVisible" title="上传凭证 Token" width="640px">
      <el-alert type="warning" show-icon :closable="false" title="Token 仅展示本次，请立即复制保存。" />
      <div class="secret-box">
        <div>
          <span class="muted">Token</span>
          <div class="mono secret-value">{{ latestCredentialToken }}</div>
        </div>
      </div>
    </el-dialog>

  </div>
</template>

<script setup lang="ts">
import { Back, Connection, Download, Key, Upload, UploadFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { http } from '@/api/http';
import { cdnApi, downloadStatsApi, fileApi, projectApi, uploadCredentialApi } from '@/api/modules';
import type {
  CdnConfig,
  DownloadStatsSummary,
  ManagedFile,
  Project,
  ProjectSecret,
  ProjectStats,
  StorageUsageResult,
} from '@/types';
import { saveBlob } from '@/utils/io';

const route = useRoute();
const router = useRouter();
const projectId = String(route.params.projectId);
const project = ref<Project | null>(null);
const stats = ref<ProjectStats | null>(null);
const activeCloudUsage = ref<StorageUsageResult | null>(null);
const hotspotsLoading = ref(false);
const hotspotDays = ref(7);
const hotspots = ref<{
  days: number;
  byReferer: Array<{ refererHost: string; hits: number; bytes: number }>;
  byFile: Array<{ fileId: string | null; originalName: string | null; hits: number; bytes: number }>;
} | null>(null);
const cdnConfigs = ref<CdnConfig[]>([]);
const files = ref<ManagedFile[]>([]);
const secrets = ref<ProjectSecret[]>([]);
const importInputRef = ref<HTMLInputElement>();
const secretDialogVisible = ref(false);
const latestSecret = ref('');
const uploadCredentials = ref<
  Array<{
    id: string;
    name: string;
    tokenPrefix: string;
    maxBytes?: number | null;
    usedBytes: number;
    maxFiles?: number | null;
    usedFiles: number;
    expiresAt: string;
    status: string;
  }>
>([]);
const credentialsLoading = ref(false);
const credentialTokenVisible = ref(false);
const latestCredentialToken = ref('');
const migrateLoading = ref(false);
const migrateForm = reactive({
  sourceCdnConfigId: '',
  targetCdnConfigId: '',
  deleteSource: false,
});
const lifecycleLoading = ref(false);
const lifecyclePolicies = ref<
  Array<{
    id: string;
    name: string;
    folderPath?: string | null;
    ttlDays: number;
    action: string;
    enabled: boolean;
  }>
>([]);

const downloadDays = ref(30);
const downloadLoading = ref(false);
const downloadSummary = ref<DownloadStatsSummary | null>(null);
const downloadItems = ref<
  Array<{
    id: string;
    fileId: string | null;
    originalName: string | null;
    bytes: number;
    source: string;
    success: boolean;
    ip: string | null;
    createdAt: string;
  }>
>([]);
const downloadTotal = ref(0);
const downloadPage = ref(1);
const downloadPageSize = 20;

function sourceLabel(source: string): string {
  return downloadSummary.value?.labels?.[source] || source;
}

async function loadDownloadStats(): Promise<void> {
  downloadLoading.value = true;
  try {
    const [summary, list] = await Promise.all([
      downloadStatsApi.summary(projectId, { days: downloadDays.value }),
      downloadStatsApi.list(projectId, {
        days: downloadDays.value,
        page: downloadPage.value,
        pageSize: downloadPageSize,
      }),
    ]);
    downloadSummary.value = summary;
    downloadItems.value = list.items;
    downloadTotal.value = list.total;
  } finally {
    downloadLoading.value = false;
  }
}
function formatTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
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

function trendHeight(count: number): number {
  const max = Math.max(...(stats.value?.uploadTrend?.map((item) => item.count) || [1]), 1);
  return Math.max(6, Math.round((count / max) * 100));
}

function formatDomains(value: string[] | undefined): string {
  return value && value.length > 0 ? value.join('、') : '使用全局白名单';
}

async function loadDetail(): Promise<void> {
  const [projectResult, statsResult, cdnResult, fileResult] = await Promise.all([
    projectApi.get(projectId),
    projectApi.stats(projectId),
    cdnApi.list(projectId),
    fileApi.list({ projectId, page: 1, pageSize: 8 }),
  ]);
  project.value = projectResult;
  stats.value = statsResult;
  cdnConfigs.value = cdnResult;
  files.value = fileResult.items;
  void loadHotspots();
  void loadDownloadStats();
  void loadActiveCloudUsage(cdnResult);
  if (projectResult.canManage) {
    const secretResult = await projectApi.listSecrets(projectId);
    secrets.value = secretResult;
    await Promise.all([loadCredentials(), loadLifecycle()]);
    if (!migrateForm.sourceCdnConfigId && cdnConfigs.value[0]) {
      migrateForm.sourceCdnConfigId = cdnConfigs.value[0].id;
    }
    if (!migrateForm.targetCdnConfigId && cdnConfigs.value[1]) {
      migrateForm.targetCdnConfigId = cdnConfigs.value[1].id;
    }
  }
}

async function loadActiveCloudUsage(list: CdnConfig[]): Promise<void> {
  const active = list.find((item) => item.active && (item.provider === 'QINIU' || item.provider === 'UPYUN'));
  if (!active) {
    activeCloudUsage.value = null;
    return;
  }
  try {
    activeCloudUsage.value = await cdnApi.usage(active.id, projectId);
  } catch {
    activeCloudUsage.value = null;
  }
}

async function loadHotspots(): Promise<void> {
  hotspotsLoading.value = true;
  try {
    hotspots.value = await projectApi.hotspots(projectId, { days: hotspotDays.value, limit: 15 });
  } catch {
    hotspots.value = { days: hotspotDays.value, byReferer: [], byFile: [] };
  } finally {
    hotspotsLoading.value = false;
  }
}

async function loadLifecycle(): Promise<void> {
  lifecycleLoading.value = true;
  try {
    lifecyclePolicies.value = (await http.get(`/projects/${projectId}/lifecycle-policies`)) as typeof lifecyclePolicies.value;
  } finally {
    lifecycleLoading.value = false;
  }
}

async function openCreateLifecycle(): Promise<void> {
  const { value: name } = await ElMessageBox.prompt('策略名称', '新建生命周期策略', {
    confirmButtonText: '下一步',
    cancelButtonText: '取消',
    inputValue: '默认 90 天回收',
  });
  const { value: ttlText } = await ElMessageBox.prompt('TTL 天数', '新建生命周期策略', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputValue: '90',
    inputPattern: /^[1-9]\d*$/,
    inputErrorMessage: '请输入正整数天数',
  });
  await http.post(`/projects/${projectId}/lifecycle-policies`, {
    name,
    ttlDays: Number(ttlText),
    action: 'RECYCLE',
    enabled: true,
  });
  ElMessage.success('策略已创建。');
  await loadLifecycle();
}

async function runLifecycle(policyId: string): Promise<void> {
  const result = (await http.post(`/projects/${projectId}/lifecycle-policies/${policyId}/run`)) as {
    affected?: number;
  };
  ElMessage.success(`已处理 ${result.affected ?? 0} 个文件。`);
}

async function removeLifecycle(policyId: string): Promise<void> {
  await ElMessageBox.confirm('删除该生命周期策略？', '删除策略', { type: 'warning' });
  await http.delete(`/projects/${projectId}/lifecycle-policies/${policyId}`);
  ElMessage.success('已删除。');
  await loadLifecycle();
}

async function startMigrate(): Promise<void> {
  if (!migrateForm.sourceCdnConfigId || !migrateForm.targetCdnConfigId) {
    ElMessage.warning('请选择源与目标存储配置。');
    return;
  }
  await ElMessageBox.confirm('迁移会在后台任务中执行，请到任务中心查看进度。', '存储迁移', {
    type: 'warning',
    confirmButtonText: '开始',
    cancelButtonText: '取消',
  });
  migrateLoading.value = true;
  try {
    const result = (await http.post(`/projects/${projectId}/storage/migrate`, migrateForm)) as { taskId?: string };
    ElMessage.success(result.taskId ? `迁移任务已创建：${result.taskId}` : '迁移任务已创建。');
  } finally {
    migrateLoading.value = false;
  }
}

async function loadCredentials(): Promise<void> {
  credentialsLoading.value = true;
  try {
    uploadCredentials.value = await uploadCredentialApi.list(projectId);
  } finally {
    credentialsLoading.value = false;
  }
}

async function openCreateCredential(): Promise<void> {
  const { value } = await ElMessageBox.prompt('凭证名称', '新建上传凭证', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputValue: '客户端直传',
    inputPattern: /^.{1,128}$/,
    inputErrorMessage: '名称不能为空。',
  });
  const result = await uploadCredentialApi.create(projectId, {
    name: value,
    expiresInSeconds: 7 * 24 * 60 * 60,
  });
  latestCredentialToken.value = result.token;
  credentialTokenVisible.value = true;
  ElMessage.success('上传凭证已创建。');
  await loadCredentials();
}

async function revokeCredential(credentialId: string): Promise<void> {
  await ElMessageBox.confirm('吊销后使用该 Token 的客户端将无法继续上传。', '吊销凭证', {
    type: 'warning',
    confirmButtonText: '吊销',
    cancelButtonText: '取消',
  });
  await uploadCredentialApi.revoke(projectId, credentialId);
  ElMessage.success('凭证已吊销。');
  await loadCredentials();
}

async function exportProject(): Promise<void> {
  await ElMessageBox.confirm('导出内容只包含项目元数据和文件记录，不包含对象存储中的真实文件内容。', '导出项目', {
    type: 'warning',
    confirmButtonText: '继续导出',
    cancelButtonText: '取消',
  });
  const payload = await projectApi.export(projectId);
  const blob = new globalThis.Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  saveBlob(blob, `${project.value?.name || 'project'}-export.json`);
}

async function importProject(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';

  if (!file) {
    return;
  }

  await ElMessageBox.confirm('导入只恢复项目和文件记录，不会复制对象存储中的真实文件内容。', '导入项目', {
    type: 'warning',
    confirmButtonText: '继续导入',
    cancelButtonText: '取消',
  });
  const payload = JSON.parse(await file.text()) as Record<string, unknown>;
  const result = await projectApi.import(payload);
  latestSecret.value = result.appSecret;
  secretDialogVisible.value = true;
  ElMessage.success(`项目已导入，文件记录 ${result.fileRecordsImported} 条。`);
  void router.push(`/projects/${result.id}`);
}

async function createSecret(): Promise<void> {
  const { value } = await ElMessageBox.prompt('密钥名称', '新增项目密钥', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputValue: '个人脚本',
    inputPattern: /^.{2,128}$/,
    inputErrorMessage: '名称长度需要在 2 到 128 个字符之间。',
  });
  const result = await projectApi.createSecret(projectId, { name: value });
  latestSecret.value = result.appSecret;
  secretDialogVisible.value = true;
  secrets.value = await projectApi.listSecrets(projectId);
  stats.value = await projectApi.stats(projectId);
}

async function disableSecret(secretId: string): Promise<void> {
  await ElMessageBox.confirm('停用后使用该 AppSecret 的脚本会立即签名失败。', '停用密钥', {
    type: 'warning',
    confirmButtonText: '停用',
    cancelButtonText: '取消',
  });
  await projectApi.disableSecret(projectId, secretId);
  ElMessage.success('项目密钥已停用。');
  secrets.value = await projectApi.listSecrets(projectId);
  stats.value = await projectApi.stats(projectId);
}

onMounted(loadDetail);
</script>

<style scoped>
.hidden-input {
  display: none;
}

.small-value {
  font-size: 17px;
  overflow-wrap: anywhere;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.section-title {
  font-weight: 700;
}

.secret-box {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}

.secret-value {
  margin-top: 6px;
  padding: 10px;
  overflow-wrap: anywhere;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-muted);
}

.full-input {
  width: 100%;
}

.metric-sub {
  margin-top: 6px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}

.trend-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 120px;
  overflow-x: auto;
  padding-top: 8px;
}

.trend-bar {
  display: flex;
  flex: 0 0 18px;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  gap: 4px;
}

.trend-fill {
  width: 12px;
  border-radius: 4px 4px 0 0;
  background: var(--el-color-primary);
  min-height: 4px;
}

.trend-label {
  font-size: 10px;
  color: #94a3b8;
  writing-mode: horizontal-tb;
  transform: scale(0.9);
}
</style>
