<script setup lang="ts">
import { computed } from 'vue'
import { NConfigProvider, NDialogProvider, NMessageProvider, NNotificationProvider, dateZhCN, zhCN } from 'naive-ui'
import { useThemeStore } from '@/stores/theme'
import { lightThemeOverrides, darkThemeOverrides } from '@/theme/naive-theme'

const themeStore = useThemeStore()
const overrides = computed(() => (themeStore.isDark ? darkThemeOverrides : lightThemeOverrides))
</script>

<template>
  <n-config-provider
    :theme="themeStore.isDark ? themeStore.darkTheme : null"
    :theme-overrides="overrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
    :css-vars="undefined"
  >
    <n-dialog-provider>
      <n-notification-provider>
        <n-message-provider>
          <router-view />
        </n-message-provider>
      </n-notification-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>
