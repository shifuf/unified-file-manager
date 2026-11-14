<template>
  <div v-if="source" class="download-source">
    <strong>{{ source.selected.configName }}（{{ storageProviderLabel(source.selected.provider) }}）</strong>
    <span v-if="source.selected.provider === 'LOCAL'" class="muted"> · 本地兜底</span>
    <div v-for="(attempt, index) in source.attempts" :key="`${attempt.configId}-${index}`" class="attempt">
      {{ index + 1 }}. {{ attempt.configName }}（{{ storageProviderLabel(attempt.provider) }}）：{{ attempt.outcome === 'SELECTED' ? '本次实际下载来源' : attempt.outcome === 'FAILED' ? '读取失败，已切换' : '跳过' }}<span v-if="attempt.reason"> · {{ attempt.reason }}</span>
    </div>
    <div v-if="source.omittedAttempts" class="muted">另 {{ source.omittedAttempts }} 条尝试记录因长度限制省略；本次实际下载平台如上。</div>
    <div v-if="source.selected.provider === 'LOCAL' && source.attempts.length === 1 && !source.omittedAttempts" class="muted">没有可读取的云副本，使用本地安全副本。</div>
  </div>
  <span v-else class="muted">服务器未返回下载来源，请更新服务端后重试。</span>
</template>
<script setup lang="ts">
import type { DownloadStorageSource } from '@/types';
import { storageProviderLabel } from '@/utils/storage-replica-view';
defineProps<{ source: DownloadStorageSource | null }>();
</script>
<style scoped>
.download-source { line-height: 1.6; overflow-wrap: anywhere; }
.attempt { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
