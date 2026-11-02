<script setup lang="ts">
import AppIcon from '@/icons/AppIcon'
import { NButton } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { onMounted, onUnmounted } from 'vue'
import { refreshUnread, unreadNotifications } from '@/composables/notificationInbox'

const props = defineProps<{ title: string; group?: string }>()
const auth = useAuthStore()
const router = useRouter()
async function logout() { await auth.logout(); await router.push('/login') }
let poll: ReturnType<typeof setInterval> | undefined
onMounted(() => { void refreshUnread(); poll = setInterval(() => { if (!document.hidden) void refreshUnread() }, 30000) })
onUnmounted(() => clearInterval(poll))

defineEmits<{ 'toggle-nav': [] }>()
</script>

<template>
  <header class="topbar">
    <button class="icon-btn menu-toggle" type="button" aria-label="打开导航" @click="$emit('toggle-nav')">
      <AppIcon name="list" :size="16" />
    </button>

    <div class="topbar-title">
      <div class="eyebrow">{{ props.group || 'Console' }}</div>
      <div class="card-title">{{ props.title }}</div>
    </div>

    <div class="topbar-actions">
      <n-button size="small" :aria-label="`通知 ${unreadNotifications} 条未读`" @click="router.push('/workbench')">通知<span v-if="unreadNotifications" class="badge">{{ unreadNotifications > 99 ? '99+' : unreadNotifications }}</span></n-button>
      <span class="badge">
        <span class="badge-dot" />
        UFM v2
      </span>
      <n-button size="small" @click="logout">退出登录</n-button>
    </div>
  </header>
</template>
