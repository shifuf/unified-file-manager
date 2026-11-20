<template>
  <div class="navigation-shell">
    <div class="brand-bar">
      <router-link to="/dashboard" class="brand" @click="select($event, '/dashboard')">
        <img src="/favicon.svg" alt="" class="brand-mark" />
        <span>统一文件管理</span>
      </router-link>
      <el-button
        v-if="closable"
        :icon="Close"
        text
        circle
        aria-label="关闭导航"
        @click="emit('close')"
      />
    </div>

    <nav class="navigation-list" aria-label="后台导航">
      <div v-for="group in groups" :key="group.label" class="navigation-group">
        <div class="navigation-label">{{ group.label }}</div>
        <ul>
          <li v-for="item in group.items" :key="item.path">
            <router-link
              :to="item.path"
              class="navigation-link"
              :class="{ 'is-current': item.path === activePath }"
              :aria-current="item.path === activePath ? 'location' : undefined"
              @click="select($event, item.path)"
            >
              <el-icon aria-hidden="true"><component :is="item.icon" /></el-icon>
              {{ item.label }}
            </router-link>
          </li>
        </ul>
      </div>
    </nav>

    <div v-if="version" class="navigation-footer">
      <span class="version-name">版本 {{ version.currentVersion }}</span>
      <span v-if="version.updateAvailable" class="version-update">可升级至 {{ version.latestVersion }}</span>
      <span v-else-if="version.state === 'available'">已是最新版本</span>
      <span v-else>版本检查暂不可用</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Close } from '@element-plus/icons-vue';

import type { VersionCheckResult } from '@/api/modules';

import type { AdminGroup } from './admin-navigation';

defineProps<{
  groups: AdminGroup[];
  activePath: string;
  version: VersionCheckResult | null;
  closable?: boolean;
}>();

const emit = defineEmits<{ select: [path: string]; close: [] }>();

function select(event: globalThis.MouseEvent, path: string): void {
  if (event.button === 0 && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
    emit('select', path);
  }
}
</script>

<style scoped>
.navigation-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  background: var(--color-surface);
}

.brand-bar {
  display: flex;
  min-height: var(--admin-header-height, 64px);
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 18px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--color-foreground);
  font-size: 16px;
  font-weight: 700;
  line-height: 1.3;
}

.brand-mark {
  width: 34px;
  height: 34px;
  flex: none;
}

.navigation-list {
  flex: 1;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 8px 12px 20px;
}

.navigation-group + .navigation-group {
  margin-block-start: 20px;
}

.navigation-label {
  padding: 3px 10px 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}

.navigation-group ul {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.navigation-link {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 11px;
  padding: 7px 10px;
  border-radius: var(--radius-control);
  color: var(--color-text);
  font-size: 14px;
  line-height: 1.4;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.navigation-link .el-icon {
  color: var(--color-text-secondary);
  font-size: 17px;
}

.navigation-link:hover {
  background: var(--color-muted);
  color: var(--color-foreground);
}

.navigation-link.is-current {
  background: var(--color-primary-soft);
  color: var(--color-primary-strong);
  font-weight: 650;
}

.navigation-link.is-current .el-icon {
  color: inherit;
}

.navigation-footer {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  column-gap: 10px;
  row-gap: 3px;
  align-items: baseline;
  justify-content: space-between;
  padding: 14px 18px;
  border-block-start: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.version-name {
  color: var(--color-text);
  font-weight: 600;
}

.version-update {
  color: var(--color-primary-strong);
}

@media (max-width: 56rem) {
  .navigation-link {
    min-height: 42px;
  }
}
</style>
