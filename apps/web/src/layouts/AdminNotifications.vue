<template>
  <el-popover
    v-model:visible="visible"
    placement="bottom-end"
    :width="360"
    :popper-style="{ maxWidth: 'calc(100% - 24px)' }"
    trigger="click"
    aria-label="通知中心"
    @show="loadNotifications"
    @after-enter="panel?.focus({ preventScroll: true })"
  >
    <template #reference>
      <el-button
        ref="trigger"
        class="notification-trigger"
        :aria-label="unreadCount ? `通知，${unreadCount} 条未读` : '通知'"
        :aria-expanded="visible"
      >
        <el-badge :value="unreadCount" :hidden="!unreadCount" :max="99" aria-hidden="true">
          <el-icon><Bell /></el-icon>
        </el-badge>
      </el-button>
    </template>
    <section
      ref="panel"
      tabindex="-1"
      aria-label="通知中心"
      class="notifications"
      @keydown.esc.stop="closePanel"
    >
      <div class="notification-heading">
        <strong>通知</strong>
        <el-button
          link
          type="primary"
          :loading="markingRead"
          :disabled="!unreadCount || loading"
          @click="markAllRead"
        >
          全部已读
        </el-button>
      </div>
      <div v-if="loadError" class="notification-feedback" role="alert">
        通知加载失败。
        <el-button link type="primary" @click="loadNotifications">重试</el-button>
      </div>
      <p v-else-if="loading && !notifications.length" class="notification-feedback" role="status">
        正在加载通知…
      </p>
      <el-empty v-else-if="!notifications.length" description="暂无通知" :image-size="52" />
      <ul v-if="notifications.length" class="notification-list">
        <li v-for="item in notifications" :key="item.id">
          <button
            v-if="item.href || !item.readAt"
            type="button"
            class="notification-item is-action"
            :class="{ unread: !item.readAt }"
            :disabled="markingRead || (!item.readAt && loading)"
            @click="openNotification(item)"
          >
            <span class="notification-title">{{ item.title }}</span>
            <span v-if="item.body" class="notification-body">{{ item.body }}</span>
            <span class="notification-time">{{ formatTime(item.createdAt) }}<span v-if="!item.readAt"> · 未读</span></span>
          </button>
          <div v-else class="notification-item">
            <span class="notification-title">{{ item.title }}</span>
            <span v-if="item.body" class="notification-body">{{ item.body }}</span>
            <span class="notification-time">{{ formatTime(item.createdAt) }}</span>
          </div>
        </li>
      </ul>
    </section>
  </el-popover>
</template>

<script setup lang="ts">
import { Bell } from '@element-plus/icons-vue';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { notificationApi } from '@/api/modules';

type Notification = Awaited<ReturnType<typeof notificationApi.list>>['items'][number];

const route = useRoute();
const router = useRouter();
const visible = ref(false);
const trigger = ref<{ $el: globalThis.HTMLButtonElement } | null>(null);
const panel = ref<globalThis.HTMLElement | null>(null);
const notifications = ref<Notification[]>([]);
const unreadCount = ref(0);
const loading = ref(false);
const loadError = ref(false);
const markingRead = ref(false);
let timer: ReturnType<typeof setInterval>;
const controller = new globalThis.AbortController();

function closePanel(): void {
  visible.value = false;
  trigger.value?.$el.focus();
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

async function loadNotifications(): Promise<void> {
  if (loading.value || markingRead.value) return;
  loading.value = true;
  loadError.value = false;
  try {
    const options = { signal: controller.signal, _silent: true };
    const [list, count] = await Promise.all([
      notificationApi.list({ page: 1, pageSize: 10 }, options),
      notificationApi.unreadCount(options),
    ]);
    notifications.value = list.items;
    unreadCount.value = count.count;
  } catch {
    if (!controller.signal.aborted) loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function markAllRead(): Promise<void> {
  if (markingRead.value || loading.value) return;
  markingRead.value = true;
  try {
    await notificationApi.markRead({ all: true });
    unreadCount.value = 0;
    const readAt = new Date().toISOString();
    notifications.value = notifications.value.map((item) => ({
      ...item,
      readAt: item.readAt || readAt,
    }));
    panel.value?.focus({ preventScroll: true });
  } catch {
    // The HTTP client shows the server error and leaves the action available for retry.
  } finally {
    markingRead.value = false;
  }
}

async function openNotification(item: Notification): Promise<void> {
  if (!item.readAt) {
    if (markingRead.value || loading.value) return;
    markingRead.value = true;
    try {
      await notificationApi.markRead({ ids: [item.id] });
      item.readAt = new Date().toISOString();
      unreadCount.value = Math.max(0, unreadCount.value - 1);
      if (!item.href) panel.value?.focus({ preventScroll: true });
    } catch {
      return;
    } finally {
      markingRead.value = false;
    }
  }
  if (item.href) {
    closePanel();
    await router.push(item.href);
  }
}

watch(
  () => route.path,
  () => {
    visible.value = false;
  },
);
onMounted(() => {
  void loadNotifications();
  timer = setInterval(() => {
    void loadNotifications();
  }, 45_000);
});
onBeforeUnmount(() => {
  controller.abort();
  clearInterval(timer);
});
</script>

<style scoped>
.notification-trigger.el-button {
  position: relative;
  width: var(--admin-control-size);
  height: var(--admin-control-size);
  margin: 0;
  padding: 0;
  color: var(--color-text);
  font-size: 19px;
}

.notification-trigger :deep(.el-badge__content) {
  top: 3px;
  inset-inline-end: 7px;
}

.notifications {
  color: var(--color-foreground);
  outline: none;
}

.notification-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 2px 4px 10px;
}

.notification-feedback {
  margin: 0;
  padding: 12px 4px;
  color: var(--color-text-secondary);
}

.notification-list {
  display: grid;
  gap: 4px;
  max-height: min(24rem, 55dvh);
  margin: 0;
  padding: 3px;
  overflow-y: auto;
  list-style: none;
}

.notification-item {
  display: grid;
  width: 100%;
  gap: 4px;
  padding: 10px;
  border: 0;
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: inherit;
  font: inherit;
  text-align: start;
  overflow-wrap: anywhere;
}

.notification-item + .notification-item {
  margin-block-start: 4px;
}

.notification-item.is-action {
  cursor: pointer;
}

.notification-item.is-action:not(:disabled):hover {
  background: var(--color-muted);
}

.notification-item:disabled {
  cursor: wait;
}

.notification-item.unread {
  background: var(--color-primary-soft);
}

.unread .notification-title {
  font-weight: 700;
}

.notification-body,
.notification-time {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.45;
}
</style>
