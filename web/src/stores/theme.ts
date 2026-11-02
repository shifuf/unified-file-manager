import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { darkTheme } from 'naive-ui'
import type { GlobalTheme } from 'naive-ui'

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'ufm.theme'

/** 首屏由 index.html 内联脚本先行打上 html.dark，这里只做状态同步。 */
function readInitialMode(): ThemeMode {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(readInitialMode())

  const isDark = computed(() => mode.value === 'dark')
  const darkThemeRef: GlobalTheme = darkTheme

  function apply(next: ThemeMode) {
    mode.value = next
    const root = document.documentElement
    root.classList.toggle('dark', next === 'dark')
    // 让浏览器原生控件（滚动条、表单、日期面板）跟随主题
    root.style.colorScheme = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  function toggle() {
    apply(mode.value === 'dark' ? 'light' : 'dark')
  }

  return { mode, isDark, toggle, apply, darkTheme: darkThemeRef }
})
