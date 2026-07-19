import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig, loadEnv } from 'vite';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

function readPortFromUrl(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const port = new URL(value).port;
    return port ? Number(port) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAdminLoginPath(raw: string | undefined): string {
  const value = String(raw ?? '').trim();
  if (!value) {
    return '/console-login';
  }
  let path = value.startsWith('/') ? value : `/${value}`;
  path = path.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!path || path === '/' || !/^\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(path)) {
    return '/console-login';
  }
  return path;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, '');
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || env.PUBLIC_URL || 'http://localhost:3000';
  const webPort = Number(env.VITE_WEB_PORT) || readPortFromUrl(env.PUBLIC_URL) || 5173;
  const adminLoginPath = normalizeAdminLoginPath(env.ADMIN_LOGIN_PATH || env.VITE_ADMIN_LOGIN_PATH);

  return {
    envDir: workspaceRoot,
    plugins: [
      vue(),
      {
        // Serve /runtime-config.js from .env during `vite dev` so local path matches Docker.
        name: 'ufm-runtime-config',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.split('?')[0] === '/runtime-config.js') {
              res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
              res.end(
                `window.__UFM_RUNTIME__ = { adminLoginPath: ${JSON.stringify(adminLoginPath)} };\n`,
              );
              return;
            }
            next();
          });
        },
      },
      AutoImport({
        resolvers: [ElementPlusResolver({ importStyle: 'css' })],
        dts: false,
      }),
      Components({
        resolvers: [ElementPlusResolver({ importStyle: 'css' })],
        dts: false,
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: webPort,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      cssCodeSplit: true,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          // Keep framework/utils stable; leave element-plus unforced so on-demand
          // component imports can co-locate with route chunks instead of one mega bundle.
          manualChunks(id) {
            if (!id.includes('node_modules')) {
              return undefined;
            }
            if (id.includes('element-plus') || id.includes('@element-plus')) {
              return undefined;
            }
            if (id.includes('vue-router') || id.includes('pinia') || /[/\\]vue[/\\]/.test(id)) {
              return 'vue';
            }
            if (id.includes('axios') || id.includes('@vueuse') || id.includes('qrcode')) {
              return 'utility';
            }
            return undefined;
          },
        },
      },
    },
  };
});
