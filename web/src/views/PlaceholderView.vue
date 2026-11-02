<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppIcon from '@/icons/AppIcon'

/**
 * 阶段 1 占位页：结构与视觉完整，功能待后续阶段接入。
 * 明确显示所属阶段，避免误以为坏掉。
 */
const route = useRoute()
const title = computed(() => (route.meta.title as string | undefined) ?? '模块')
const phase = computed(() => (route.meta.phase as string | undefined) ?? '后续阶段')
const icon = computed(() => (route.meta.icon as string | undefined) ?? 'file')
</script>

<template>
  <div class="placeholder">
    <section class="card">
      <div class="card-head">
        <div class="ph-title-row">
          <span class="metric-icon">
            <AppIcon :name="icon" :size="16" />
          </span>
          <h1 class="page-title">{{ title }}</h1>
        </div>
        <span class="tag tag-info">{{ phase }}</span>
      </div>

      <p class="page-subtitle">
        该模块的路由、布局与视觉规范已就绪，业务接口将在 {{ phase }} 接入。
      </p>

      <div class="ph-body">
        <div class="ph-empty">
          <AppIcon name="layers" :size="44" :stroke-width="1.2" />
          <div class="ph-empty-title">骨架已就绪</div>
          <div class="ph-empty-desc">
            阶段 1 只交付工程骨架、错误模型与设计系统；功能页按路线图逐阶段填充。
          </div>
        </div>

        <div class="ph-meta">
          <div class="ph-meta-item">
            <span class="field-label">路由</span>
            <span class="font-mono">{{ route.path }}</span>
          </div>
          <div class="ph-meta-item">
            <span class="field-label">计划阶段</span>
            <span class="font-mono">{{ phase }}</span>
          </div>
          <div class="ph-meta-item">
            <span class="field-label">状态</span>
            <span class="tag tag-warning">待实现</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.placeholder {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ph-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ph-title-row .metric-icon {
  margin-bottom: 0;
}

.ph-body {
  margin-top: 18px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 16px;
}

.ph-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  padding: 44px 20px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-card);
  background: var(--bg-soft);
  color: var(--text-muted);
}

.ph-empty-title {
  font-size: 13px;
  font-weight: 800;
  color: var(--text-strong);
}

.ph-empty-desc {
  font-size: 12px;
  max-width: 340px;
  line-height: 1.65;
}

.ph-meta {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: var(--r-card);
  border: 1px solid var(--border);
  background: var(--bg-soft);
}

.ph-meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

@media (max-width: 900px) {
  .ph-body {
    grid-template-columns: 1fr;
  }
}
</style>
