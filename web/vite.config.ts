import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 本地开发把 /api 代理到 Spring Boot（阶段 1 端口 8080）
const API_TARGET = process.env.UFM_API_TARGET ?? 'http://127.0.0.1:8080'
const publicNavigation = (req: { url?: string; headers: { accept?: string } }) =>
  req.headers.accept?.includes('text/html') && /^\/(s|fs|lib)\/[^/?]+(?:\?.*)?$/.test(req.url ?? '') ? '/index.html' : undefined

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/s/': { target: API_TARGET, changeOrigin: false, bypass: publicNavigation },
      '/fs/': { target: API_TARGET, changeOrigin: false, bypass: publicNavigation },
      '/lib/': { target: API_TARGET, changeOrigin: false, bypass: publicNavigation },
      '/d/': { target: API_TARGET, changeOrigin: false },
      '/dav/': { target: API_TARGET, changeOrigin: false },
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          naive: ['naive-ui'],
        },
      },
    },
  },
})
