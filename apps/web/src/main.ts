import { createPinia } from 'pinia';
import { createApp } from 'vue';

// Full Element Plus styles: imperative APIs (ElMessage / ElMessageBox / ElNotification /
// ElLoading) are imported in script and do not go through on-demand CSS resolvers.
// Without this, toasts/dialogs render as unstyled plain text (bottom-left) or broken overlays.
import 'element-plus/dist/index.css';

import { bindHttpRouter } from './api/http';
import App from './App.vue';
import router from './router';
import './assets/styles.css';

const app = createApp(App);

app.use(createPinia());
app.use(router);
bindHttpRouter(router);

app.mount('#app');

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
