<template>
  <div class="share-state" :role="loading ? 'status' : 'alert'" aria-live="polite">
    <el-icon class="state-icon" :class="{ 'is-loading': loading }" :size="42">
      <Loading v-if="loading" />
      <WarningFilled v-else />
    </el-icon>
    <h1>{{ loading ? '正在加载分享信息' : error?.title }}</h1>
    <p>{{ loading ? '请稍候，正在获取分享内容。' : error?.description }}</p>
    <div v-if="!loading" class="state-actions">
      <el-button v-if="error?.retryable" type="primary" @click="$emit('retry')">重新加载</el-button>
      <el-button tag="a" href="/">返回首页</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Loading, WarningFilled } from '@element-plus/icons-vue';

import type { PublicShareFailure } from '@/utils/public-share';

defineProps<{ loading?: boolean; error?: PublicShareFailure | null }>();
defineEmits<{ retry: [] }>();
</script>

<style scoped>
.share-state { display: grid; justify-items: center; padding: 40px 20px; text-align: center; }
.state-icon { margin-bottom: 22px; color: #94a3b8; }
.share-state h1 { margin: 0; color: #1e293b; font-size: 23px; line-height: 1.4; }
.share-state p { max-width: 420px; margin: 14px 0 0; color: #64748b; font-size: 14px; line-height: 1.85; }
.state-actions { display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; margin-top: 28px; }
.state-actions .el-button { margin-left: 0; }
@media (max-width: 640px) {
  .share-state { padding: 30px 8px; }
  .share-state h1 { font-size: 21px; }
}
</style>
