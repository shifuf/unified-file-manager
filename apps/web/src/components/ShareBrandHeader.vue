<template>
  <header class="share-brand-header" :style="{ background: brand.panelBackground }">
    <a class="share-brand" href="/" :aria-label="`${title}首页`">
      <img v-if="brand.logoUrl && !logoFailed" class="brand-logo" :src="brand.logoUrl" alt="" @error="logoFailed = true" />
      <span class="brand-copy">
        <span class="brand-title" :style="{ color: brand.primaryColor }">{{ title }}</span>
        <span v-if="brand.subtitle" class="brand-subtitle">{{ brand.subtitle }}</span>
      </span>
    </a>
    <span class="share-brand-label">文件分享</span>
  </header>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { SharePageBrand } from '@/types';

const props = defineProps<{ brand: SharePageBrand; siteName: string }>();
const logoFailed = ref(false);
const title = computed(() => props.brand.title?.trim() || props.siteName);
watch(() => props.brand.logoUrl, () => { logoFailed.value = false; });
</script>

<style scoped>
.share-brand-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 72px;
  width: 100%;
  padding: 16px 32px;
  border-bottom: 1px solid #e2e8f0;
}
.share-brand {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 12px;
  text-decoration: none;
}
.brand-logo { width: 36px; height: 36px; flex: none; object-fit: contain; border-radius: 6px; }
.brand-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
.brand-title { font-size: 18px; line-height: 1.35; font-weight: 650; overflow-wrap: anywhere; }
.brand-subtitle { color: #64748b; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.share-brand-label { color: #94a3b8; font-size: 13px; flex: none; }
@media (max-width: 640px) {
  .share-brand-header { min-height: 64px; padding: 14px 16px; gap: 12px; }
  .brand-title { font-size: 16px; }
  .share-brand-label { display: none; }
}
</style>
