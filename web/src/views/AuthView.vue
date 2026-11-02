<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NInput, NAlert } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/theme'
import AppIcon from '@/icons/AppIcon'

const auth = useAuthStore()
const theme = useThemeStore()
const router = useRouter()
const bootstrap = computed(() => auth.initialized === false)
const username = ref('')
const displayName = ref('')
const password = ref('')
const confirmation = ref('')
const code = ref('')
const busy = ref(false)
const error = ref('')
async function submit() {
  error.value = ''
  if (bootstrap.value && password.value !== confirmation.value) { error.value = '两次密码不一致'; return }
  busy.value = true
  try {
    if (bootstrap.value) {
      await auth.bootstrap(username.value, displayName.value, password.value)
      password.value = ''; confirmation.value = ''
      await router.replace('/login')
    } else { await auth.login(username.value, password.value, code.value); await router.replace('/workbench') }
  } catch (raw) { error.value = raw instanceof Error ? raw.message : '请求失败' }
  finally { busy.value = false }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-story">
      <div class="auth-brand"><span class="brand-mark"><AppIcon name="layers" :size="20" /></span> 统一文件管理</div>
      <div class="eyebrow">YOUR FILES. YOUR INFRASTRUCTURE.</div>
      <h2>每一份文件，<br>都有自己的位置。</h2>
      <p>连接你的存储，整理你的工作，安全分享每一个重要瞬间。</p>
      <div class="auth-principles"><span>独立部署</span><span>单管理员</span><span>隐私优先</span></div>
      <button class="btn btn-secondary" type="button" @click="theme.toggle()">{{ theme.isDark ? '切换浅色' : '切换深色' }}</button>
    </section>
    <section class="card auth-card">
      <span class="badge"><span class="badge-dot" />{{ bootstrap ? 'FIRST RUN' : 'WELCOME BACK' }}</span>
      <h1>{{ bootstrap ? '初始化你的文件空间' : '欢迎回来' }}</h1>
      <p class="auth-help">{{ bootstrap ? '创建唯一管理员。初始化后将永久关闭此入口。' : '登录管理控制台，继续你的工作。' }}</p>
      <n-alert v-if="error" type="error" role="alert" :show-icon="false">{{ error }}</n-alert>
      <form class="auth-form" @submit.prevent="submit">
        <label for="admin-username">管理员用户名</label>
        <n-input v-model:value="username" :input-props="{ id: 'admin-username', 'aria-label': '管理员用户名', autocomplete: 'username', required: true }" placeholder="例如 owner" />
        <template v-if="bootstrap">
          <label for="display-name">显示名称</label>
          <n-input v-model:value="displayName" :input-props="{ id: 'display-name', 'aria-label': '显示名称', autocomplete: 'name', required: true }" placeholder="你的称呼" />
        </template>
        <label for="admin-password">管理员密码</label>
        <n-input v-model:value="password" type="password" show-password-on="click" :input-props="{ id: 'admin-password', 'aria-label': '管理员密码', autocomplete: bootstrap ? 'new-password' : 'current-password', required: true }" placeholder="至少 10 位并包含数字" />
        <template v-if="bootstrap">
          <label for="confirm-password">确认密码</label>
          <n-input v-model:value="confirmation" type="password" :input-props="{ id: 'confirm-password', 'aria-label': '确认密码', autocomplete: 'new-password', required: true }" placeholder="再次输入密码" />
        </template>
        <template v-else>
          <label for="totp-code">动态验证码（已启用时填写）</label>
          <n-input id="totp-code" v-model:value="code" :input-props="{ id: 'totp-code', autocomplete: 'one-time-code', inputmode: 'numeric' }" placeholder="6 位验证码" />
        </template>
        <n-button type="primary" attr-type="submit" :loading="busy" block size="large">{{ bootstrap ? '完成初始化' : '登录控制台' }}</n-button>
      </form>
      <p class="auth-security"><AppIcon name="lock" :size="14" />密码以 BCrypt 单向哈希保存，无法查看或还原。</p>
    </section>
  </main>
</template>

<style scoped>
.auth-page { min-height: 100vh; display: grid; grid-template-columns: 1.05fr 1fr; align-items: center; gap: 8vw; max-width: 1180px; padding: 48px 32px; margin: auto; }
.auth-brand { display: flex; align-items: center; gap: 12px; font-size: 18px; font-weight: 800; margin-bottom: 76px; }
.auth-story h2 { font-size: clamp(32px, 4vw, 50px); line-height: 1.3; letter-spacing: -.04em; color: var(--text-strong); }
.auth-story p { color: var(--text-muted); max-width: 350px; font-size: 15px; }
.auth-principles { display: flex; gap: 20px; margin: 32px 0; color: var(--accent-ink); font-weight: 600; }
.auth-card { padding: 34px; min-width: 0; }
h1 { font-size: 26px; letter-spacing: -.03em; margin-bottom: 8px; color: var(--text-strong); }
.auth-help, .auth-security { color: var(--text-muted); }
.auth-form { display: grid; gap: 10px; margin: 26px 0; }
.auth-form label { margin-top: 8px; font-weight: 600; }
.auth-form :deep(.n-button) { margin-top: 14px; }
.auth-security { display: flex; gap: 7px; align-items: center; font-size: 11px; }
@media (max-width: 900px) { .auth-page { gap: 30px; padding: 32px 22px; } .auth-card { padding: 24px; } .auth-story h2 { font-size: 32px; } }
@media (max-width: 640px) { .auth-page { display: block; padding: 24px 14px; } .auth-brand { margin-bottom: 24px; } .auth-story > :not(.auth-brand) { display: none; } .auth-card { padding: 24px 18px; } h1 { font-size: 23px; } }
</style>
