<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppSidebar from '@/components/AppSidebar.vue'
import AppTopbar from '@/components/AppTopbar.vue'

/**
 * 应用外壳：左侧栏 + 右侧主区。
 * 布局与间距体系沿用既有实现（248px 侧栏 / 20px 外边距 / 16px 纵向节奏），
 * 仅视觉层由 tokens.css + components.css 接管。
 */
const route = useRoute()
const navOpen = ref(false)

const currentTitle = computed(() => (route.meta.title as string | undefined) ?? '工作台')
const currentGroup = computed(() => (route.meta.group as string | undefined) ?? '')

// 路由切换后自动收起移动端抽屉
watch(() => route.fullPath, () => {
  navOpen.value = false
})
</script>

<template>
  <div class="app-shell">
    <AppSidebar :open="navOpen" @close="navOpen = false" />

    <main class="app-main">
      <AppTopbar :title="currentTitle" :group="currentGroup" @toggle-nav="navOpen = !navOpen" />

      <router-view v-slot="{ Component }">
        <transition name="page-fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
    </main>

    <!-- 移动端遮罩 -->
    <div v-if="navOpen" class="nav-scrim" @click="navOpen = false" />
  </div>
</template>

<style scoped>
.page-fade-enter-active,
.page-fade-leave-active {
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}

.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-fade-leave-to {
  opacity: 0;
}

.nav-scrim {
  position: fixed;
  inset: 0;
  z-index: 55;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}
</style>
