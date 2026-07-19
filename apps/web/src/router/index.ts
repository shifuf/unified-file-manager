import { createRouter, createWebHistory } from 'vue-router';

import { getAdminLoginPath } from '@/config/runtime';
import { useAuthStore } from '@/stores/auth';

// Login path is configured via ADMIN_LOGIN_PATH (.env → runtime-config.js).
const adminLoginPath = getAdminLoginPath();

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/Home.vue'),
      meta: { public: true },
    },
    {
      path: adminLoginPath,
      name: 'login',
      component: () => import('@/views/Login.vue'),
      meta: { public: true },
    },
    {
      path: '/shares/:token',
      name: 'share-access',
      component: () => import('@/views/ShareAccess.vue'),
      meta: { public: true },
    },
    {
      // Pretty share URL: /s/docs/readme maps to multi-segment customPath.
      path: '/s/:pathMatch(.*)+',
      name: 'share-access-custom',
      component: () => import('@/views/ShareAccess.vue'),
      meta: { public: true },
    },
    {
      path: '/folder-shares/:token',
      name: 'folder-share-access',
      component: () => import('@/views/FolderShareAccess.vue'),
      meta: { public: true },
    },
    {
      path: '/library/:slug',
      name: 'public-library',
      component: () => import('@/views/PublicLibrary.vue'),
      meta: { public: true },
    },
    {
      // Layout parent only. Child routes use absolute paths (/dashboard, …)
      // so they render at the site root while still using AdminLayout.
      path: '/console',
      component: () => import('@/layouts/AdminLayout.vue'),
      children: [
        { path: '/dashboard', name: 'dashboard', component: () => import('@/views/Dashboard.vue') },
        { path: '/projects', name: 'projects', component: () => import('@/views/Projects.vue') },
        { path: '/projects/:projectId', name: 'project-detail', component: () => import('@/views/ProjectDetail.vue') },
        { path: '/files', name: 'files', component: () => import('@/views/Files.vue') },
        { path: '/recycle-bin', name: 'recycle-bin', component: () => import('@/views/Files.vue') },
        { path: '/shares', name: 'shares', component: () => import('@/views/Shares.vue') },
        {
          path: '/developer-integration',
          name: 'developer-integration',
          component: () => import('@/views/DeveloperIntegration.vue'),
        },
        { path: '/cdn-configs', redirect: (to) => ({ path: '/storage-configs', query: to.query }) },
        { path: '/storage-configs', name: 'storage-configs', component: () => import('@/views/CdnConfigs.vue') },
        { path: '/tasks', name: 'tasks', component: () => import('@/views/Tasks.vue') },
        { path: '/webhooks', name: 'webhooks', component: () => import('@/views/Webhooks.vue') },
        { path: '/audit-logs', name: 'audit-logs', component: () => import('@/views/AuditLogs.vue') },
        { path: '/share-ip-abuse', name: 'share-ip-abuse', component: () => import('@/views/ShareIpAbuse.vue') },
        { path: '/system-health', name: 'system-health', component: () => import('@/views/SystemHealth.vue') },
        { path: '/settings', name: 'settings', component: () => import('@/views/Settings.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();

  // Cookie session may exist without local profile (fresh tab / cleared storage).
  // Probe /auth/profile once for protected routes before treating as anonymous.
  if (!to.meta.public && !authStore.currentUser) {
    try {
      await authStore.loadProfile();
    } catch {
      return { name: 'home' };
    }
  }

  if (!to.meta.public && !authStore.loggedIn) {
    return { name: 'home' };
  }

  if (to.name === 'login' && authStore.loggedIn) {
    return { name: 'dashboard' };
  }

  // Force password change: hard-block other console routes until password is updated.
  // Dashboard still loads AdminLayout which hosts the forced security dialog.
  if (
    authStore.loggedIn &&
    authStore.currentUser?.mustChangePassword &&
    !to.meta.public &&
    to.name !== 'dashboard' &&
    to.name !== 'login'
  ) {
    return { name: 'dashboard', query: { forcePassword: '1' } };
  }

  return true;
});

export default router;
