<template>
  <el-config-provider :locale="zhCn">
    <div :class="{ 'public-shell': route.meta.public }">
      <router-view />
      <SiteFooter v-if="route.meta.public && !isSharePage" />
    </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import SiteFooter from '@/components/SiteFooter.vue';

const route = useRoute();
const isSharePage = computed(() => ['share-access', 'share-access-custom', 'folder-share-access'].includes(String(route.name)));
</script>

<style scoped>
.public-shell {
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  flex-direction: column;
}

.public-shell > :first-child {
  flex: 1;
}
</style>
