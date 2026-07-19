<template>
  <el-container class="admin-shell">
    <el-aside class="admin-sidebar" width="232px">
      <div class="brand">
        <div class="brand-mark">U</div>
        <div>
          <div class="brand-name">统一文件管理</div>
          <div class="brand-subtitle">Multi Project Files</div>
        </div>
      </div>

      <el-menu :default-active="activePath" class="side-menu" @select="handleMenuSelect">
        <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="admin-header" height="64px">
        <div class="header-left">
          <el-button class="mobile-menu-button" :icon="MenuIcon" circle @click="mobileMenuVisible = true" />
          <el-select
            v-model="selectedProjectId"
            filterable
            clearable
            placeholder="选择当前项目"
            class="project-select"
            @change="handleProjectChange"
          >
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
        </div>
        <div class="header-right">
          <el-popover placement="bottom-end" :width="360" trigger="click" @show="loadNotifications">
            <template #reference>
              <el-badge :value="unreadCount || undefined" :hidden="!unreadCount" class="notify-badge">
                <el-button circle>通</el-button>
              </el-badge>
            </template>
            <div class="notify-panel">
              <div class="notify-head">
                <strong>通知</strong>
                <el-button link type="primary" @click="markAllRead">全部已读</el-button>
              </div>
              <div v-if="notifications.length === 0" class="muted notify-empty">暂无通知</div>
              <div
                v-for="item in notifications"
                :key="item.id"
                class="notify-item"
                :class="{ unread: !item.readAt }"
                @click="openNotification(item)"
              >
                <div class="notify-title">{{ item.title }}</div>
                <div v-if="item.body" class="notify-body">{{ item.body }}</div>
                <div class="notify-time">{{ formatNotifyTime(item.createdAt) }}</div>
              </div>
            </div>
          </el-popover>
          <span class="user-name">{{ authStore.currentUser?.displayName }}</span>
          <el-tag :type="authStore.currentUser?.totpEnabled ? 'success' : 'info'">
            2FA {{ authStore.currentUser?.totpEnabled ? '已启用' : '未启用' }}
          </el-tag>
          <el-button :icon="Key" @click="openSecurityDialog">账号安全</el-button>
          <el-button :icon="SwitchButton" @click="logout">退出</el-button>
        </div>
      </el-header>

      <el-main class="admin-main">
        <router-view />
      </el-main>
    </el-container>

    <el-drawer v-model="mobileMenuVisible" direction="ltr" :with-header="false" size="280px" class="mobile-menu-drawer">
      <div class="mobile-sidebar">
        <div class="brand">
          <div class="brand-mark">U</div>
          <div>
            <div class="brand-name">统一文件管理</div>
            <div class="brand-subtitle">Multi Project Files</div>
          </div>
        </div>

        <el-menu :default-active="activePath" class="side-menu" @select="handleMenuSelect">
          <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </el-menu-item>
        </el-menu>
      </div>
    </el-drawer>

    <el-dialog v-model="securityDialogVisible" title="账号安全" width="620px">
      <div class="security-panel">
        <div class="security-status">
          <div>
            <div class="section-title">登录密码</div>
            <div class="muted">修改当前账号密码后，需要使用新密码重新登录。</div>
          </div>
        </div>
        <el-form label-position="top" class="password-form">
          <el-form-item label="当前密码">
            <el-input v-model="passwordForm.currentPassword" type="password" show-password autocomplete="current-password" />
          </el-form-item>
          <el-form-item label="新密码">
            <el-input v-model="passwordForm.newPassword" type="password" show-password autocomplete="new-password" />
          </el-form-item>
          <el-button type="primary" :loading="passwordLoading" @click="changePassword">修改密码</el-button>
        </el-form>

        <el-divider />

        <div class="security-status">
          <div>
            <div class="section-title">二次验证</div>
            <div class="muted">兼容 Google Authenticator、Microsoft Authenticator 等 TOTP 应用。</div>
          </div>
          <el-tag :type="authStore.currentUser?.totpEnabled ? 'success' : 'info'">
            {{ authStore.currentUser?.totpEnabled ? '已启用' : '未启用' }}
          </el-tag>
        </div>

        <template v-if="!authStore.currentUser?.totpEnabled">
          <el-alert
            type="info"
            show-icon
            :closable="false"
            title="使用认证器 App 扫描二维码，再输入 6 位验证码完成启用。"
          />
          <el-button type="primary" :loading="totpLoading" @click="setupTotp">生成扫码二维码</el-button>
          <div v-if="totpSetup" class="totp-bind">
            <div class="qr-card">
              <img v-if="totpQrCodeUrl" :src="totpQrCodeUrl" alt="2FA 绑定二维码" class="totp-qr" />
              <el-skeleton v-else animated :rows="4" />
            </div>
            <div class="totp-guide">
              <div class="section-title">扫码绑定</div>
              <ol>
                <li>打开 Google Authenticator、Microsoft Authenticator 或兼容 TOTP 的认证器。</li>
                <li>选择扫描二维码，并扫描左侧二维码。</li>
                <li>把认证器显示的 6 位验证码填入下方，完成启用。</li>
              </ol>
              <el-collapse>
                <el-collapse-item title="无法扫码？使用手动密钥" name="manual-secret">
                  <div class="totp-box">
                    <div>
                      <span class="muted">账号</span>
                      <div class="mono breakable">{{ totpSetup.account }}</div>
                    </div>
                    <div>
                      <span class="muted">密钥</span>
                      <div class="secret-line">
                        <span class="mono breakable">{{ totpSetup.secret }}</span>
                        <el-button link type="primary" @click="copyText(totpSetup.secret)">复制</el-button>
                      </div>
                    </div>
                  </div>
                </el-collapse-item>
              </el-collapse>
            </div>
          </div>
          <el-form label-position="top" class="totp-form">
            <el-form-item label="Authenticator 验证码">
              <el-input v-model="totpCode" maxlength="6" inputmode="numeric" placeholder="6 位数字" />
            </el-form-item>
            <el-button type="primary" :loading="totpLoading" :disabled="!totpSetup" @click="enableTotp">
              验证并启用
            </el-button>
          </el-form>
        </template>

        <template v-else>
          <el-alert type="warning" show-icon :closable="false" title="关闭二次验证前需要输入当前 Authenticator 验证码。" />
          <el-form label-position="top" class="totp-form">
            <el-form-item label="Authenticator 验证码">
              <el-input v-model="totpCode" maxlength="6" inputmode="numeric" placeholder="6 位数字" />
            </el-form-item>
            <el-button type="danger" :loading="totpLoading" @click="disableTotp">验证并关闭</el-button>
          </el-form>
        </template>

        <el-divider />
        <div class="security-status">
          <div>
            <div class="section-title">登录会话</div>
            <div class="muted">可吊销其他设备上的会话。</div>
          </div>
          <el-button size="small" @click="loadSessions">刷新</el-button>
        </div>
        <el-table v-loading="sessionsLoading" :data="sessions" size="small" row-key="id">
          <el-table-column label="设备" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.userAgent || '-' }}</template>
          </el-table-column>
          <el-table-column prop="ip" label="IP" width="120" />
          <el-table-column label="当前" width="70">
            <template #default="{ row }">
              <el-tag v-if="row.current" size="small" type="success">是</el-tag>
              <span v-else class="muted">否</span>
            </template>
          </el-table-column>
          <el-table-column label="" width="70">
            <template #default="{ row }">
              <el-button v-if="!row.current" link type="danger" @click="revokeSession(row.id)">吊销</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-button style="margin-top: 8px" @click="revokeOtherSessions">吊销其他会话</el-button>
      </div>
    </el-dialog>
  </el-container>
</template>

<script setup lang="ts">
import {
  Connection,
  DataAnalysis,
  Delete,
  Files,
  Folder,
  Guide,
  Key,
  Link,
  List,
  Menu as MenuIcon,
  Memo,
  Monitor,
  Setting,
  SwitchButton,
  Warning,
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { toDataURL } from 'qrcode';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { authApi, notificationApi, projectApi, sessionApi, type TotpSetupResult } from '@/api/modules';
import { useAuthStore } from '@/stores/auth';
import type { Project } from '@/types';
import { copyText } from '@/utils/io';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
const projects = ref<Project[]>([]);
const selectedProjectId = ref<string>('');
const securityDialogVisible = ref(false);
const mobileMenuVisible = ref(false);
const totpLoading = ref(false);
const passwordLoading = ref(false);
const totpCode = ref('');
const totpSetup = ref<TotpSetupResult | null>(null);
const unreadCount = ref(0);
const notifications = ref<
  Array<{
    id: string;
    title: string;
    body?: string | null;
    href?: string | null;
    readAt?: string | null;
    createdAt: string;
  }>
>([]);
const sessions = ref<
  Array<{
    id: string;
    ip?: string | null;
    userAgent?: string | null;
    createdAt: string;
    expiresAt: string;
    current: boolean;
  }>
>([]);
const sessionsLoading = ref(false);
let notifyTimer: ReturnType<typeof setInterval> | undefined;
const totpQrCodeUrl = ref('');
const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
});
const activePath = computed(() => (route.path.startsWith('/projects/') ? '/projects' : route.path));
const projectScopedPaths = new Set([
  '/files',
  '/recycle-bin',
  '/storage-configs',
  '/developer-integration',
  '/tasks',
  '/webhooks',
]);
const menuItems = computed(() => {
  const items = [
    { path: '/dashboard', label: '概览', icon: DataAnalysis },
    { path: '/projects', label: '项目管理', icon: Folder },
    { path: '/files', label: '文件管理', icon: Files },
    { path: '/recycle-bin', label: '回收站', icon: Delete },
    { path: '/shares', label: '分享管理', icon: Link },
    { path: '/developer-integration', label: '开发对接', icon: Guide },
    { path: '/storage-configs', label: '存储配置', icon: Connection },
    { path: '/tasks', label: '任务中心', icon: List },
    { path: '/webhooks', label: '出站 Webhook', icon: Link },
  ];

  if (authStore.isSuperAdmin) {
    items.push(
      { path: '/audit-logs', label: '日志审计', icon: Memo },
      { path: '/share-ip-abuse', label: 'IP 防刷', icon: Warning },
      { path: '/system-health', label: '系统健康', icon: Monitor },
      { path: '/settings', label: '系统设置', icon: Setting },
    );
  }

  return items;
});

async function loadProjects(): Promise<void> {
  projects.value = await projectApi.list();
  syncSelectedProjectFromRoute();
}

function handleProjectChange(): void {
  if (!selectedProjectId.value) {
    if (['/files', '/recycle-bin'].includes(route.path)) {
      void router.replace({ path: route.path, query: {} });
    }

    return;
  }

  if (route.name === 'project-detail') {
    void router.replace({ path: `/projects/${selectedProjectId.value}` });
    return;
  }

  if (projectScopedPaths.has(route.path)) {
    void router.replace({ path: route.path, query: { projectId: selectedProjectId.value } });
  }
}

function handleMenuSelect(path: string): void {
  mobileMenuVisible.value = false;
  const query =
    projectScopedPaths.has(path) && !['/files', '/recycle-bin'].includes(path) && selectedProjectId.value
      ? { projectId: selectedProjectId.value }
      : {};
  void router.push({ path, query });
}

function syncSelectedProjectFromRoute(): void {
  const routeProjectId = readRouteProjectId();

  if (routeProjectId && projects.value.some((project) => project.id === routeProjectId)) {
    selectedProjectId.value = routeProjectId;
    return;
  }

  if (!selectedProjectId.value) {
    selectedProjectId.value = projects.value[0]?.id || '';
  }
}

function readRouteProjectId(): string {
  const value = route.query.projectId || route.params.projectId;
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function openSecurityDialog(): void {
  totpCode.value = '';
  totpSetup.value = null;
  totpQrCodeUrl.value = '';
  securityDialogVisible.value = true;
  void loadSessions();
}

function formatNotifyTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : '-';
}

async function loadNotifications(): Promise<void> {
  try {
    const [list, count] = await Promise.all([
      notificationApi.list({ page: 1, pageSize: 10 }),
      notificationApi.unreadCount(),
    ]);
    notifications.value = list.items;
    unreadCount.value = count.count;
  } catch {
    // Best-effort notification poll; failures are non-fatal.
  }
}

async function markAllRead(): Promise<void> {
  await notificationApi.markRead({ all: true });
  unreadCount.value = 0;
  notifications.value = notifications.value.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() }));
}

async function openNotification(item: { id: string; href?: string | null; readAt?: string | null }): Promise<void> {
  if (!item.readAt) {
    await notificationApi.markRead({ ids: [item.id] });
    item.readAt = new Date().toISOString();
    unreadCount.value = Math.max(0, unreadCount.value - 1);
  }
  if (item.href) {
    void router.push(item.href);
  }
}

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true;
  try {
    sessions.value = await sessionApi.list();
  } finally {
    sessionsLoading.value = false;
  }
}

async function revokeSession(id: string): Promise<void> {
  await sessionApi.revoke(id);
  ElMessage.success('会话已吊销。');
  await loadSessions();
}

async function revokeOtherSessions(): Promise<void> {
  const result = await sessionApi.revokeOthers();
  ElMessage.success(`已吊销 ${result.revoked} 个其他会话。`);
  await loadSessions();
}

async function setupTotp(): Promise<void> {
  totpLoading.value = true;
  try {
    const setup = await authApi.setupTotp();
    totpSetup.value = setup;
    totpQrCodeUrl.value = await toDataURL(setup.otpauthUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 220,
    });
  } finally {
    totpLoading.value = false;
  }
}

async function enableTotp(): Promise<void> {
  if (!/^\d{6}$/.test(totpCode.value)) {
    ElMessage.error('请输入 6 位验证码。');
    return;
  }

  totpLoading.value = true;
  try {
    await authApi.enableTotp(totpCode.value);
    await authStore.loadProfile();
    totpCode.value = '';
    totpSetup.value = null;
    totpQrCodeUrl.value = '';
    ElMessage.success('二次验证已启用。');
  } finally {
    totpLoading.value = false;
  }
}

async function disableTotp(): Promise<void> {
  if (!/^\d{6}$/.test(totpCode.value)) {
    ElMessage.error('请输入 6 位验证码。');
    return;
  }

  totpLoading.value = true;
  try {
    await authApi.disableTotp(totpCode.value);
    await authStore.loadProfile();
    totpCode.value = '';
    ElMessage.success('二次验证已关闭。');
  } finally {
    totpLoading.value = false;
  }
}

async function changePassword(): Promise<void> {
  if (!passwordForm.currentPassword || passwordForm.newPassword.length < 8) {
    ElMessage.warning('请填写当前密码，新密码至少 8 位。');
    return;
  }

  passwordLoading.value = true;
  try {
    const wasForced = Boolean(authStore.currentUser?.mustChangePassword);
    await authApi.changePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
    });
    passwordForm.currentPassword = '';
    passwordForm.newPassword = '';
    await authStore.loadProfile();
    ElMessage.success(wasForced ? '密码已修改，强制改密要求已解除。' : '密码已修改。');
    securityDialogVisible.value = false;
  } finally {
    passwordLoading.value = false;
  }
}

function logout(): void {
  void authStore.logout();
  ElMessage.success('已退出登录。');
  void router.replace({ name: 'home' });
}

onMounted(async () => {
  await authStore.loadProfile();
  await loadProjects();
  await loadNotifications();
  if (authStore.currentUser?.mustChangePassword) {
    ElMessage.warning('管理员要求修改密码后才能继续使用。');
    openSecurityDialog();
  }
  notifyTimer = setInterval(() => {
    void loadNotifications();
  }, 45_000);
});

onBeforeUnmount(() => {
  if (notifyTimer) {
    clearInterval(notifyTimer);
  }
});

watch(
  () => route.fullPath,
  () => syncSelectedProjectFromRoute(),
);
</script>

<style scoped>
.admin-shell {
  min-height: 100vh;
}

.admin-sidebar {
  border-right: 1px solid var(--color-border);
  background: #ffffff;
}

.mobile-sidebar {
  min-height: 100%;
  background: #ffffff;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 64px;
  padding: 0 18px;
  border-bottom: 1px solid var(--color-border);
}

.brand-mark {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 8px;
  color: #ffffff;
  background: var(--color-primary);
  font-weight: 700;
}

.brand-name {
  font-size: 15px;
  font-weight: 700;
}

.brand-subtitle {
  margin-top: 2px;
  color: #64748b;
  font-size: 12px;
}

.side-menu {
  border-right: 0;
}

.admin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid var(--color-border);
  background: #ffffff;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.mobile-menu-button {
  display: none;
}

.project-select {
  width: 280px;
  max-width: 48vw;
}

.notify-badge {
  margin-right: 4px;
}

.notify-panel {
  max-height: 420px;
  overflow: auto;
}

.notify-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.notify-item {
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
}

.notify-item.unread .notify-title {
  font-weight: 700;
}

.notify-title {
  font-size: 13px;
}

.notify-body {
  margin-top: 2px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notify-empty {
  padding: 24px 0;
  text-align: center;
  color: #94a3b8;
  font-size: 13px;
}

.notify-time {
  margin-top: 2px;
  color: #94a3b8;
  font-size: 12px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-name {
  color: #334155;
  font-size: 14px;
}

.admin-main {
  padding: 20px;
}

.security-panel {
  display: grid;
  gap: 16px;
}

.security-status {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.section-title {
  margin-bottom: 6px;
  font-weight: 700;
}

.totp-box {
  display: grid;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-muted);
}

.totp-bind {
  display: grid;
  gap: 18px;
  grid-template-columns: 240px minmax(0, 1fr);
  align-items: start;
}

.qr-card {
  display: grid;
  min-height: 240px;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: #ffffff;
}

.totp-qr {
  width: 220px;
  height: 220px;
}

.totp-guide {
  min-width: 0;
}

.totp-guide ol {
  margin: 0 0 12px 18px;
  padding: 0;
  color: #475569;
  font-size: 13px;
  line-height: 1.7;
}

.secret-line {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-top: 4px;
}

.breakable {
  overflow-wrap: anywhere;
}

.totp-form {
  max-width: 360px;
}

.password-form {
  max-width: 420px;
}

@media (max-width: 760px) {
  .admin-shell {
    display: block;
  }

  .admin-sidebar {
    display: none;
  }

  .admin-header {
    align-items: flex-start;
    height: auto;
    padding: 12px;
    flex-direction: column;
  }

  .header-left {
    width: 100%;
  }

  .mobile-menu-button {
    display: inline-flex;
    flex: 0 0 auto;
  }

  .project-select {
    width: 100%;
    max-width: none;
  }

  .header-right {
    align-items: stretch;
    width: 100%;
    flex-wrap: wrap;
  }

  .secret-line {
    flex-direction: column;
  }

  .totp-bind {
    grid-template-columns: 1fr;
  }
}
</style>
