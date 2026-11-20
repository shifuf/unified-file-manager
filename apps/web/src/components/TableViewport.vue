<template>
  <div
    ref="viewport"
    class="table-viewport"
    :class="{ 'has-overflow': overflows }"
    role="region"
    :aria-label="label"
    :aria-describedby="overflows ? hintId : undefined"
    :tabindex="overflows ? 0 : undefined"
    @keydown="scrollWithKeyboard"
  >
    <p v-if="overflows" :id="hintId" class="table-scroll-hint">
      <span aria-hidden="true">↔</span><span>左右滚动查看完整表格和操作</span>
    </p>
    <slot :pin-actions="width >= 720" />
  </div>
</template>

<script setup lang="ts">
import { useElementSize } from '@vueuse/core';
import { nextTick, onMounted, onUpdated, ref, useId, watch } from 'vue';

defineProps<{ label: string }>();

const viewport = ref<globalThis.HTMLElement>();
const { width, height } = useElementSize(viewport);
const overflows = ref(false);
const hintId = useId();

function measureOverflow(): void {
  const scroll = viewport.value?.querySelector<globalThis.HTMLElement>('.el-table__body-wrapper .el-scrollbar__wrap');
  overflows.value = Boolean(scroll && scroll.scrollWidth > scroll.clientWidth + 1);
}

function scrollWithKeyboard(event: globalThis.KeyboardEvent): void {
  if (event.target !== viewport.value || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const scroll = viewport.value?.querySelector<globalThis.HTMLElement>('.el-table__body-wrapper .el-scrollbar__wrap');
  if (!scroll) return;
  event.preventDefault();
  scroll.scrollBy({ left: event.key === 'ArrowRight' ? 160 : -160 });
}

watch([width, height], () => nextTick(measureOverflow), { flush: 'post' });
onMounted(() => nextTick(measureOverflow));
onUpdated(measureOverflow);
</script>

<style scoped>
.table-viewport {
  width: 100%;
  min-width: 0;
}

.table-viewport:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
}

.table-scroll-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.table-viewport :deep(.el-scrollbar__bar.is-horizontal) {
  opacity: 1;
}

.table-viewport :deep(.el-table .cell),
.table-viewport :deep(.el-table .cell .el-button.is-link > span),
.table-viewport :deep(.el-tag__content) {
  overflow-wrap: anywhere;
}

.table-viewport :deep(.el-table .cell .el-button.is-link) {
  max-width: 100%;
  height: auto;
  white-space: normal;
  text-align: start;
  line-height: inherit;
}

.table-viewport :deep(.table-actions) {
  flex-wrap: wrap;
  max-width: 100%;
}

.table-viewport :deep(.el-tag) {
  max-width: 100%;
  height: auto;
  min-height: 20px;
  white-space: normal;
  line-height: 1.6;
}
</style>
