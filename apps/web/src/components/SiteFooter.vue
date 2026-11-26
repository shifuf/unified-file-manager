<template>
  <footer class="site-footer" aria-label="站点信息">
    <p v-if="text" class="site-footer-text">{{ text }}</p>
    <p class="site-footer-meta">
      <span>© {{ year }}</span>
      <span v-if="showBrand">{{ siteName }}</span>
      <span>v{{ version }}</span>
    </p>
  </footer>
</template>

<script setup lang="ts">
import { version } from '../../package.json';
import { PUBLIC_SITE_NAME } from '@/config/site-name';

withDefaults(defineProps<{ text?: string; showBrand?: boolean; siteName?: string }>(), {
  text: '',
  showBrand: true,
  siteName: PUBLIC_SITE_NAME,
});
const year = new Date().getFullYear();
</script>

<style scoped>
.site-footer {
  flex: none;
  padding: 20px 24px max(20px, env(safe-area-inset-bottom));
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  overflow-wrap: anywhere;
}

.site-footer-text {
  margin: 0 0 6px;
  white-space: pre-line;
}

.site-footer-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 2px 8px;
  margin: 0;
}

.site-footer-meta span + span::before {
  content: '·';
  margin-inline-end: 8px;
}
</style>
