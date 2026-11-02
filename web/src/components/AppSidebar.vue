<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from '@/icons/AppIcon'
import { useThemeStore } from '@/stores/theme'
import { useAuthStore } from '@/stores/auth'

/**
 * 侧边栏：导航项由路由表 meta 生成，避免菜单与路由两处维护。
 * 视觉：24px 圆角白渐变 + 两团蓝色光球（见 components.css .sidebar）。
 */
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const route = useRoute()
const router = useRouter()
const theme = useThemeStore()
const auth = useAuthStore()

interface NavLink {
  name: string
  path: string
  title: string
  icon: string
  group: string
}

const links = computed<NavLink[]>(() => {
  const shell = router.getRoutes().find((r) => r.path === '/' && r.children?.length)
  const children = shell?.children ?? []
  return children
    .filter((c) => c.meta?.title)
    .map((c) => ({
      name: String(c.name ?? ''),
      path: '/' + c.path,
      title: String(c.meta?.title ?? ''),
      icon: String(c.meta?.icon ?? 'file'),
      group: String(c.meta?.group ?? '其他'),
    }))
})

const groups = computed(() => {
  const map = new Map<string, NavLink[]>()
  for (const link of links.value) {
    const list = map.get(link.group) ?? []
    list.push(link)
    map.set(link.group, list)
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }))
})

const isActive = (link: NavLink) => route.name === link.name
</script>

<template>
  <aside class="sidebar" :class="{ 'is-open': open }">
    <div class="sidebar-brand">
      <span class="brand-mark">
        <AppIcon name="layers" :size="18" />
      </span>
      <span class="brand-text">
        <span class="brand-name">统一文件管理</span>
        <span class="brand-meta">UFM Console</span>
      </span>
    </div>

    <nav class="sidebar-nav">
      <div v-for="group in groups" :key="group.label" class="nav-group">
        <div class="nav-group-label">{{ group.label }}</div>
        <router-link
          v-for="link in group.items"
          :key="link.name"
          :to="link.path"
          class="nav-item"
          :class="{ 'is-active': isActive(link) }"
          @click="emit('close')"
        >
          <AppIcon class="nav-icon" :name="link.icon" :size="16" />
          <span class="nav-label">{{ link.title }}</span>
        </router-link>
      </div>
    </nav>

    <div class="sidebar-footer">
      <div class="sidebar-user">
        <span class="sidebar-avatar">UF</span>
        <span class="sidebar-user-meta">
          <span class="sidebar-user-name">{{ auth.user?.displayName || auth.user?.username || '管理员' }}</span>
          <span class="sidebar-user-role">Administrator</span>
        </span>
      </div>
      <button class="icon-btn" type="button" :aria-label="theme.isDark ? '切换浅色' : '切换深色'" @click="theme.toggle()">
        <AppIcon :name="theme.isDark ? 'sun' : 'moon'" :size="16" />
      </button>
    </div>
  </aside>
</template>
