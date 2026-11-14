<template>
  <button type="button" class="storage-tags" aria-label="查看存储副本" @click="$emit('open')">
    <template v-if="locations?.length"><strong class="download-priority">{{ preferredDownloadLabel(locations) }}</strong><span class="replica-tags"><el-tag v-for="item in locations.slice(0, 3)" :key="item.configId" :type="replicaTagType(item)" size="small">{{ item.configName }} · {{ replicaLabel(item) }}</el-tag><el-tag v-if="locations.length > 3" type="info" size="small">另 {{ locations.length - 3 }} 个</el-tag></span></template>
    <span v-else class="muted">{{ error ? '状态加载失败，查看详情' : '查看存储状态' }}</span>
    <span v-if="error && locations?.length" class="muted">刷新失败</span>
  </button>
</template>
<script setup lang="ts">
import type { FileStorageLocation } from '@/types';
import { preferredDownloadLabel, replicaLabel, replicaTagType } from '@/utils/storage-replica-view';
defineProps<{ locations: FileStorageLocation[] | null; error?: boolean }>();
defineEmits<{ open: [] }>();
</script>
<style scoped>
.storage-tags { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; border: 0; background: transparent; text-align: left; padding: 4px 0; cursor: pointer; font: inherit; }
.replica-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.download-priority { color: var(--el-color-primary); font-size: 12px; }
.storage-tags:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
</style>
