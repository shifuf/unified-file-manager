<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">系统健康</h1>
        <p class="page-subtitle">查看数据库、运行环境和关键数据量状态。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadHealth">刷新</el-button>
    </div>

    <section class="metric-grid">
      <div class="metric">
        <div class="metric-label">整体状态</div>
        <div class="metric-value">
          <el-tag :type="health?.status === 'OK' ? 'success' : 'warning'">{{ health?.status || '-' }}</el-tag>
        </div>
      </div>
      <div class="metric">
        <div class="metric-label">数据库</div>
        <div class="metric-value">
          <el-tag :type="health?.database?.status === 'OK' ? 'success' : 'danger'">
            {{ health?.database?.status || '-' }}
          </el-tag>
        </div>
      </div>
      <div class="metric">
        <div class="metric-label">项目</div>
        <div class="metric-value">{{ health?.counts.projects ?? 0 }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">有效文件</div>
        <div class="metric-value">{{ health?.counts.activeFiles ?? 0 }}</div>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-title">运行信息</div>
        <el-descriptions v-if="health" :column="2" border>
          <el-descriptions-item label="检查时间">{{ formatTime(health.checkedAt) }}</el-descriptions-item>
          <el-descriptions-item label="Node">{{ health.runtime.nodeVersion }}</el-descriptions-item>
          <el-descriptions-item label="环境">{{ health.runtime.environment }}</el-descriptions-item>
          <el-descriptions-item label="回收站文件">{{ health.counts.recycledFiles }}</el-descriptions-item>
          <el-descriptions-item label="任务总数">{{ health.counts.tasks }}</el-descriptions-item>
          <el-descriptions-item label="失败任务">{{ health.counts.failedTasks }}</el-descriptions-item>
        </el-descriptions>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-title">当前设置</div>
        <el-table :data="settingRows" row-key="key" size="small">
          <el-table-column prop="key" label="配置项" min-width="220" />
          <el-table-column prop="value" label="值" min-width="260" show-overflow-tooltip />
        </el-table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue';
import { computed, onMounted, ref } from 'vue';

import { settingsApi } from '@/api/modules';
import type { SystemHealth } from '@/types';

const loading = ref(false);
const health = ref<SystemHealth | null>(null);
const settingLabels: Record<string, string> = {
  maxFileSizeMb: '单个文件大小（MB）',
  maxBatchUploadCount: '单次上传数量',
  recycleRetentionDays: '回收站保留天数',
  requireHttps: '要求 HTTPS 访问',
  publicFileAllowedDomains: '公开文件允许访问域名',
};
const settingRows = computed(() =>
  Object.entries(health.value?.settings || {}).map(([key, value]) => ({
    key: settingLabels[key] || key,
    value: formatSettingValue(key, value),
  })),
);

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatSettingValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join('、') : key === 'publicFileAllowedDomains' ? '未设置，默认仅允许当前访问域名' : '未设置';
  }

  if (typeof value === 'boolean') {
    return value ? '开启' : '关闭';
  }

  return value === undefined || value === null || value === '' ? '未设置' : String(value);
}

async function loadHealth(): Promise<void> {
  loading.value = true;
  try {
    health.value = await settingsApi.health();
  } finally {
    loading.value = false;
  }
}

onMounted(loadHealth);
</script>

<style scoped>
.section-title {
  margin-bottom: 12px;
  font-weight: 700;
}
</style>
