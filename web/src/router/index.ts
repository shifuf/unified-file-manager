import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import AppShell from '@/layouts/AppShell.vue'
import { useAuthStore } from '@/stores/auth'

const routes: RouteRecordRaw[] = [
  { path: '/upload', component: () => import('@/views/GuestUploadView.vue'), meta: { public: true, visitor: true } },
  { path: '/:kind(s|fs|lib)/:token', component: () => import('@/views/PublicView.vue'), meta: { public: true, visitor: true } },
  { path: '/login', name: 'login', component: () => import('@/views/AuthView.vue'), meta: { public: true } },
  { path: '/initialize', name: 'initialize', component: () => import('@/views/AuthView.vue'), meta: { public: true } },
  {
    path: '/',
    component: AppShell,
    redirect: '/workbench',
    children: [
      {
        path: 'workbench',
        name: 'workbench',
        component: () => import('@/views/DashboardView.vue'),
        meta: { title: '工作台', icon: 'dashboard', group: '总览' },
      },
      {
        path: 'files',
        name: 'files',
        component: () => import('@/views/FilesView.vue'),
        meta: { title: '文件', icon: 'files', group: '内容', phase: '阶段 4' },
      },
      {
        path: 'shares',
        name: 'shares',
        component: () => import('@/views/SharesView.vue'),
        meta: { title: '分享', icon: 'share', group: '内容', phase: '阶段 5' },
      },
      {
        path: 'projects',
        name: 'projects',
        component: () => import('@/views/ProjectsView.vue'),
        meta: { title: '项目', icon: 'project', group: '内容', phase: '阶段 3' },
      },
      {
        path: 'storages',
        name: 'storages',
        component: () => import('@/views/StoragesView.vue'),
        meta: { title: '存储', icon: 'storage', group: '资源', phase: '阶段 3' },
      },
      {
        path: 'tasks',
        name: 'tasks',
        component: () => import('@/views/TasksView.vue'),
        meta: { title: '任务', icon: 'tasks', group: '资源', phase: '阶段 6' },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/views/StatisticsView.vue'),
        meta: { title: '分发统计', icon: 'audit', group: '系统' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/SettingsView.vue'),
        meta: { title: '设置', icon: 'settings', group: '系统', phase: '阶段 3' },
      },
      { path: 'backups', name: 'backups', component: () => import('@/views/BackupsView.vue'), meta: { title: '备份', icon: 'storage', group: '资源' } },
      { path: 'audit-logs', name: 'audit-logs', component: () => import('@/views/AuditView.vue'), meta: { title: '审计日志', icon: 'shield', group: '系统' } },
      { path: 'developer', name: 'developer', component: () => import('@/views/DeveloperView.vue'), meta: { title: '开发者接口', icon: 'webhook', group: '系统' } },
      {
        path: 'style-guide',
        name: 'style-guide',
        component: () => import('@/views/StyleGuideView.vue'),
        meta: { title: '设计规范', icon: 'palette', group: '系统' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  if (to.meta.visitor) return true
  const auth = useAuthStore()
  if (auth.initialized === null) await auth.status()
  if (!auth.initialized) return to.path === '/initialize' ? true : '/initialize'
  if (to.path === '/initialize') return '/login'
  if (to.meta.public) return true
  if (!auth.token && !await auth.refresh()) return '/login'
  return true
})

router.afterEach((to) => {
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} · 统一文件管理` : '统一文件管理'
})

export default router
