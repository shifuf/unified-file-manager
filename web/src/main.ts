import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

// 字体：Inter（UI）/ JetBrains Mono（等宽）/ Calistoga（展示标题）
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/inter/latin-800.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/calistoga/latin-400.css'

// 样式分层：令牌 → 基础 → 组件 → Naive UI 适配
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/naive-overrides.css'
import './styles/modules.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
