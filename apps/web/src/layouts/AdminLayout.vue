<template>
  <el-container class="admin-shell">
    <a class="skip-link" href="#main-content" @click.prevent="focusMain">跳到主要内容</a>
    <el-aside class="admin-sidebar" width="var(--sidebar-width)">
      <AdminNavigation :groups="menuGroups" :active-path="activePath" :version="versionCheck" />
    </el-aside>

    <el-container class="admin-content">
      <el-header class="admin-header" height="var(--admin-header-height)">
        <div class="header-left">
          <el-button
            ref="mobileMenuButton"
            class="mobile-menu-button"
            :icon="MenuIcon"
            aria-label="打开导航"
            aria-haspopup="dialog"
            :aria-expanded="mobileMenuVisible"
            @click="mobileMenuVisible = true"
          />
          <el-breadcrumb
            class="header-breadcrumb"
            :separator-icon="ArrowRight"
            aria-label="当前位置"
          >
            <el-breadcrumb-item class="workspace-crumb">管理控制台</el-breadcrumb-item>
            <el-breadcrumb-item v-if="route.name === 'project-detail'" :to="{ path: '/projects' }">项目管理</el-breadcrumb-item>
            <el-breadcrumb-item>{{ currentPageTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="header-right">
          <AdminNotifications />
          <el-dropdown trigger="click" placement="bottom-end" @command="handleAccountCommand">
            <el-button
              class="account-trigger"
              :aria-label="`账号菜单，${accountName}`"
              :title="accountName"
            >
              <span class="account-avatar" aria-hidden="true">{{ avatarLetter }}</span>
              <span class="account-name">{{ accountName }}</span>
              <el-icon class="account-chevron" aria-hidden="true"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>
                  {{ authStore.currentUser?.totpEnabled ? '二次验证已启用' : '二次验证未启用' }}
                </el-dropdown-item>
                <el-dropdown-item command="security" :icon="Key" divided>账号安全</el-dropdown-item>
                <el-dropdown-item command="logout" :icon="SwitchButton">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main
        id="main-content"
        ref="mainContent"
        class="admin-main"
        tabindex="-1"
        aria-label="主要内容"
        @scroll="updateMainScroll"
      >
        <div class="admin-page-frame">
          <router-view />
        </div>
        <SiteFooter />
      </el-main>
      <el-button
        v-show="mainScrollTop > 240"
        class="back-to-top"
        type="primary"
        :icon="Top"
        aria-label="返回顶部"
        @click="scrollToTop"
        >返回顶部</el-button>
    </el-container>

    <el-drawer
      v-model="mobileMenuVisible"
      :direction="textDirection === 'rtl' ? 'rtl' : 'ltr'"
      :with-header="false"
      title="后台导航"
      size="min(288px, 90%)"
      body-class="mobile-navigation-body"
      class="mobile-menu-drawer"
      @closed="restoreMenuFocus"
    >
      <AdminNavigation
        :groups="menuGroups"
        :active-path="activePath"
        :version="versionCheck"
        closable
        @select="handleMenuSelect"
        @close="mobileMenuVisible = false"
      />
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
            <el-input
              v-model="passwordForm.currentPassword"
              type="password"
              show-password
              autocomplete="current-password"
            />
          </el-form-item>
          <el-form-item label="新密码">
            <el-input
              v-model="passwordForm.newPassword"
              type="password"
              show-password
              autocomplete="new-password"
            />
          </el-form-item>
          <el-button type="primary" :loading="passwordLoading" @click="changePassword">修改密码</el-button>
        </el-form>

        <el-divider />

        <div class="security-status">
          <div>
            <div class="section-title">二次验证</div>
            <div class="muted">
              兼容 Google Authenticator、Microsoft Authenticator 等 TOTP 应用。
            </div>
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
              <el-input
                v-model="totpCode"
                maxlength="6"
                inputmode="numeric"
                placeholder="6 位数字"
              />
            </el-form-item>
            <el-button
              type="primary"
              :loading="totpLoading"
              :disabled="!totpSetup"
              @click="enableTotp"
            >
              验证并启用
            </el-button>
          </el-form>
        </template>

        <template v-else>
          <el-alert
            type="warning"
            show-icon
            :closable="false"
            title="关闭二次验证前需要输入当前 Authenticator 验证码。"
          />
          <el-form label-position="top" class="totp-form">
            <el-form-item label="Authenticator 验证码">
              <el-input
                v-model="totpCode"
                maxlength="6"
                inputmode="numeric"
                placeholder="6 位数字"
              />
            </el-form-item>
            <el-button type="danger" :loading="totpLoading" @click="disableTotp">验证并关闭</el-button>
          </el-form>
        </template>

        <el-divider />
        <section v-loading="sessionsLoading" class="sessions-section" aria-labelledby="login-sessions-title">
          <div class="security-status">
            <h3 id="login-sessions-title" class="section-title">登录会话</h3>
            <el-button size="small" :loading="sessionsLoading" @click="loadSessions">刷新会话</el-button>
          </div>
          <p class="session-help muted">
            浏览器和其他客户端的历史登录会保留到退出或到期。同一 IP 可能有多个会话，过期和已退出的会话不会显示。
          </p>
          <p v-if="!sessionsLoading && !hasCurrentSession" class="session-unconfirmed" role="status">
            暂时无法确认当前会话，请刷新后重试。
          </p>
          <ul class="session-list" aria-label="登录会话">
            <li v-for="session in sessions" :key="session.id" class="session-card">
              <div class="session-heading">
                <h4 class="session-device-label">{{ sessionDeviceLabel(session.userAgent) }}</h4>
                <el-tag size="small" :type="session.current ? 'success' : 'info'">
                  {{ session.current ? '当前会话' : '其他会话' }}
                </el-tag>
              </div>
              <dl class="session-metadata">
                <div>
                  <dt>IP 地址</dt>
                  <dd>{{ session.ip || '未知' }}</dd>
                </div>
                <div>
                  <dt>登录时间</dt>
                  <dd><time :datetime="session.createdAt">{{ sessionTime(session.createdAt) }}</time></dd>
                </div>
                <div>
                  <dt>到期时间</dt>
                  <dd><time :datetime="session.expiresAt">{{ sessionTime(session.expiresAt) }}</time></dd>
                </div>
              </dl>
              <details class="session-details">
                <summary>浏览器信息</summary>
                <p class="session-user-agent">{{ session.userAgent || '客户端未提供浏览器信息。' }}</p>
              </details>
              <div v-if="!session.current" class="session-actions">
                <el-button
                  size="small"
                  :disabled="!hasCurrentSession || sessionsLoading || sessionsRevoking"
                  @click="revokeSession(session.id)"
                >退出此会话</el-button>
              </div>
            </li>
          </ul>
          <el-button
            :loading="sessionsRevoking"
            :disabled="!hasCurrentSession || !hasOtherSessions || sessionsLoading"
            @click="revokeOtherSessions"
          >退出其他会话</el-button>
        </section>
      </div>
    </el-dialog>
  </el-container>
</template>

<script setup lang="ts">
import {
  ArrowDown,
  ArrowRight,
  Key,
  Menu as MenuIcon,
  SwitchButton,
  Top,
} from '@element-plus/icons-vue';
import { useMediaQuery, useTextDirection } from '@vueuse/core';
import { ElMessage } from 'element-plus';
import { toDataURL } from 'qrcode';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  authApi,
  sessionApi,
  versionApi,
  type TotpSetupResult,
  type VersionCheckResult,
} from '@/api/modules';
import { useAuthStore } from '@/stores/auth';
import { copyText } from '@/utils/io';
import SiteFooter from '@/components/SiteFooter.vue';

import AdminNavigation from './AdminNavigation.vue';
import AdminNotifications from './AdminNotifications.vue';
import { adminNavigation } from './admin-navigation';

const versionCheck = ref<VersionCheckResult | null>(null);

const route = useRoute();
const router = useRouter();
const mainContent = ref<{ $el: globalThis.HTMLElement } | null>(null);
const mainScrollTop = ref(0);
const mobileMenuButton = ref<{ $el: globalThis.HTMLButtonElement } | null>(null);
const compactNavigation = useMediaQuery('(max-width: 56rem)');
const textDirection = useTextDirection({ observe: true });
const previousTitle = document.title;
let navigatedFromMenu = false;
const versionController = new globalThis.AbortController();
function focusMain(): void {
  if (!securityDialogVisible.value && !mobileMenuVisible.value) {
    mainContent.value?.$el.focus({ preventScroll: true });
  }
}
function restoreMenuFocus(): void {
  if (navigatedFromMenu) focusMain();
  else mobileMenuButton.value?.$el.focus({ preventScroll: true });
  navigatedFromMenu = false;
}
function updateMainScroll(event: Event): void {
  mainScrollTop.value = (event.target as globalThis.HTMLElement).scrollTop;
}
function scrollToTop(): void {
  mainContent.value?.$el.scrollTo({
    top: 0,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}
watch(
  () => route.path,
  async () => {
    await nextTick();
    mainContent.value?.$el.scrollTo({ top: 0, behavior: 'instant' });
    mainScrollTop.value = 0;
    focusMain();
  },
);
const authStore = useAuthStore();
const securityDialogVisible = ref(false);
const mobileMenuVisible = ref(false);
watch(compactNavigation, (compact) => {
  if (!compact && mobileMenuVisible.value) {
    navigatedFromMenu = true;
    mobileMenuVisible.value = false;
  }
});
const totpLoading = ref(false);
const passwordLoading = ref(false);
const totpCode = ref('');
const totpSetup = ref<TotpSetupResult | null>(null);
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
const sessionsRevoking = ref(false);
const hasCurrentSession = computed(() => sessions.value.some((session) => session.current));
const hasOtherSessions = computed(() => sessions.value.some((session) => !session.current));
const totpQrCodeUrl = ref('');
const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
});
const activePath = computed(() => (route.path.startsWith('/projects/') ? '/projects' : route.path));
const menuGroups = computed(() =>
  adminNavigation.filter((group) => !group.adminOnly || authStore.isSuperAdmin),
);
const currentPageTitle = computed(() =>
  route.name === 'project-detail'
    ? '项目详情'
    : menuGroups.value
        .flatMap((group) => group.items)
        .find((item) => item.path === activePath.value)?.label || '管理控制台',
);
const accountName = computed(() => authStore.currentUser?.displayName || '管理员');
const avatarLetter = computed(() => Array.from(accountName.value)[0]);
watch(
  currentPageTitle,
  (title) => {
    document.title = title + ' · 统一文件管理';
  },
  { immediate: true },
);

function handleMenuSelect(path: string): void {
  navigatedFromMenu = route.path !== path;
  mobileMenuVisible.value = false;
}

function handleAccountCommand(command: string): void {
  if (command === 'security') openSecurityDialog();
  else if (command === 'logout') logout();
}

function openSecurityDialog(): void {
  totpCode.value = '';
  totpSetup.value = null;
  totpQrCodeUrl.value = '';
  securityDialogVisible.value = true;
  void loadSessions();
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
  if (!hasCurrentSession.value || sessionsRevoking.value) return;
  sessionsRevoking.value = true;
  try {
    await sessionApi.revoke(id);
    ElMessage.success('已退出此会话。');
    await loadSessions();
  } finally {
    sessionsRevoking.value = false;
  }
}

async function revokeOtherSessions(): Promise<void> {
  if (!hasCurrentSession.value || sessionsRevoking.value) return;
  sessionsRevoking.value = true;
  try {
    await sessionApi.revokeOthers();
    ElMessage.success('已退出其他会话，当前会话继续保留。');
    await loadSessions();
  } finally {
    sessionsRevoking.value = false;
  }
}

function sessionDeviceLabel(userAgent?: string | null): string {
  if (!userAgent) return '未识别的客户端';
  const browserPatterns = [
    ['Microsoft Edge', /Edg(?:A|iOS)?\/(\d+)/],
    ['Opera', /(?:OPR|Opera)\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['Safari', /Version\/(\d+).*Safari\//],
  ] as const;
  const browser = browserPatterns.find(([, pattern]) => pattern.test(userAgent));
  if (!browser) return userAgent;
  const version = browser[1].exec(userAgent)?.[1];
  const platform = /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent) ? 'iOS'
      : /Windows/.test(userAgent) ? 'Windows'
        : /Macintosh|Mac OS X/.test(userAgent) ? 'macOS'
          : /Linux/.test(userAgent) ? 'Linux' : '';
  return `${browser[0]} ${version}${platform ? ` · ${platform}` : ''}`;
}

function sessionTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '未知' : time.toLocaleString('zh-CN', { hour12: false });
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
  if (authStore.currentUser?.role === 'SUPER_ADMIN') {
    try {
      versionCheck.value = await versionApi.check({
        signal: versionController.signal,
        _silent: true,
      });
    } catch {
      /* configured source may be offline */
    }
  }
  if (authStore.currentUser?.mustChangePassword) {
    ElMessage.warning('管理员要求修改密码后才能继续使用。');
    openSecurityDialog();
  }
});

onBeforeUnmount(() => {
  versionController.abort();
  document.title = previousTitle;
});
</script>

<style scoped>
.admin-shell {
  --admin-header-height: 64px;
  --admin-control-size: 36px;
  --admin-gutter: clamp(24px, 2.4vw, 40px);
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

.skip-link {
  position: fixed;
  z-index: 3000;
  inset-block-start: 8px;
  inset-inline-start: 12px;
  transform: translateY(-160%);
  padding: 10px 16px;
  border-radius: var(--radius-control);
  background: var(--color-foreground);
  color: #fff;
}

.skip-link:focus {
  transform: none;
}

.admin-content {
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.admin-sidebar {
  flex: none;
  height: 100%;
  overflow: hidden;
  border-inline-end: 1px solid var(--color-border);
}

.admin-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-inline: var(--admin-gutter);
  border-block-end: 1px solid var(--color-border);
  background: var(--color-surface);
}

.header-left,
.header-right {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}

.header-left {
  flex: 1;
}

.header-right {
  flex: none;
}

.mobile-menu-button.el-button {
  display: none;
  width: var(--admin-control-size);
  height: var(--admin-control-size);
  flex: none;
  padding: 0;
  font-size: 19px;
}

.header-breadcrumb {
  min-width: 0;
  line-height: 1.5;
}

.header-breadcrumb :deep(.el-breadcrumb__item:last-child .el-breadcrumb__inner) {
  color: var(--color-text);
  font-weight: 600;
}

.account-trigger.el-button {
  display: flex;
  height: var(--admin-control-size);
  gap: 9px;
  padding: 3px 9px 3px 4px;
  color: var(--color-text);
}

.account-trigger :deep(> span) {
  gap: 9px;
}

.account-avatar {
  display: grid;
  width: 26px;
  height: 26px;
  flex: none;
  place-items: center;
  border: 1px solid #d8e4fc;
  border-radius: 6px;
  background: var(--color-primary-soft);
  color: var(--color-primary-strong);
  font-size: 12px;
  font-weight: 650;
}

.account-name {
  max-width: 112px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.account-chevron {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.admin-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scroll-padding-block: 24px;
  padding: var(--admin-gutter);
  padding-block-end: max(var(--admin-gutter), env(safe-area-inset-bottom));
  outline: none;
}

.admin-page-frame {
  flex: 1 0 auto;
  container: admin-page / inline-size;
  width: 100%;
  max-width: 1600px;
  min-width: 0;
  margin-inline: auto;
}

.back-to-top {
  position: fixed;
  inset-inline-end: 24px;
  inset-block-end: max(24px, env(safe-area-inset-bottom));
  z-index: 20;
  box-shadow: 0 4px 14px #12213820;
}

:deep(.mobile-navigation-body) {
  height: 100%;
  padding: 0;
  overflow: hidden;
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

.sessions-section {
  container: login-sessions / inline-size;
  min-width: 0;
}

.sessions-section .section-title {
  margin-block: 0;
  font-size: 15px;
}

.session-help,
.session-unconfirmed {
  margin-block: 10px 16px;
  font-size: 13px;
  line-height: 1.6;
}

.session-unconfirmed {
  color: var(--color-text-secondary);
}

.session-list {
  display: grid;
  gap: 12px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
}

.session-card {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.session-heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.session-device-label {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: normal;
}

.session-heading .el-tag {
  flex: none;
}

.session-metadata {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 16px;
  margin-block: 14px 10px;
  font-size: 13px;
  line-height: 1.6;
}

.session-metadata dt {
  color: var(--color-text-secondary);
}

.session-metadata dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.session-details {
  font-size: 13px;
  line-height: 1.6;
}

.session-details summary {
  width: fit-content;
  color: var(--color-primary-strong);
  cursor: pointer;
}

.session-user-agent {
  margin-block: 8px 0;
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
  white-space: normal;
}

.session-actions {
  display: flex;
  justify-content: flex-end;
  margin-block-start: 12px;
}

@container login-sessions (max-width: 25rem) {
  .session-metadata {
    grid-template-columns: minmax(0, 1fr);
  }
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

@media (max-width: 56rem) {
  .admin-shell {
    --admin-control-size: 40px;
    --admin-gutter: 20px;
  }

  .admin-sidebar {
    display: none;
  }

  .admin-header {
    min-height: var(--admin-header-height);
    height: auto;
    padding-top: env(safe-area-inset-top);
    padding-left: max(16px, env(safe-area-inset-left));
    padding-right: max(16px, env(safe-area-inset-right));
  }

  .mobile-menu-button.el-button {
    display: inline-flex;
  }

  .workspace-crumb {
    display: none;
  }

}

@media (max-width: 36rem) {
  .admin-header {
    gap: 8px;
    padding-inline: 12px;
  }

  .header-left,
  .header-right {
    gap: 8px;
  }

  .header-breadcrumb :deep(.el-breadcrumb__separator) {
    margin-inline: 5px;
  }

  .header-breadcrumb :deep(.el-breadcrumb__item) {
    font-size: 12px;
  }

  .account-trigger.el-button {
    width: var(--admin-control-size);
    justify-content: center;
    padding: 0;
  }

  .account-name,
  .account-chevron {
    display: none;
  }

  .admin-shell { --admin-gutter: 14px; }

  .admin-main { padding-block-start: 20px; }

  .secret-line {
    flex-direction: column;
  }

  .totp-bind {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
