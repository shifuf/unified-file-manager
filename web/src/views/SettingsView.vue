<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NInput, NTabs, NTabPane, useMessage } from 'naive-ui'
import { http } from '@/api/http'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import NotificationChannels from '@/components/NotificationChannels.vue'
import DisplayPreferences from '@/components/DisplayPreferences.vue'
import GlobalSettings from '@/components/GlobalSettings.vue'
import LifecycleSettings from '@/components/LifecycleSettings.vue'
import SystemStatus from '@/components/SystemStatus.vue'
interface Session { id: string; userAgent: string; current: boolean; expiresAt?: string }
const sessions = ref<Session[]>([])
const password = ref('')
const nextPassword = ref('')
const code = ref('')
const seed = ref('')
const error = ref('')
const brand = ref({ title: '', subtitle: '', footer: '', poweredBy: true, logo: '', pageBackground: 'bg', cardBackground: 'surface' })
const auth = useAuthStore()
const router = useRouter()
const message = useMessage()
const tab = ref('account')
async function load() { try { sessions.value = (await http.get<{ items: Session[] }>('/auth/sessions')).items } catch (e) { error.value = String(e) } }
async function revoke(id: string) { try { await http.delete(`/auth/sessions/${id}`); await load() } catch (e) { message.error(String(e)) } }
async function changePassword() { try { await http.post('/auth/password', { currentPassword: password.value, newPassword: nextPassword.value, code: code.value || undefined }); password.value = ''; nextPassword.value = ''; await auth.logout(); await router.push('/login') } catch (e) { message.error(String(e)) } }
async function setup() { try { seed.value = (await http.post<{ secret: string }>('/auth/2fa/setup', { password: password.value })).secret } catch (e) { message.error(String(e)) } }
async function factor(action: string) { try { await http.post(`/auth/2fa/${action}`, { password: password.value, code: code.value }); seed.value = ''; password.value = ''; code.value = ''; message.success('双因素认证设置已更新') } catch (e) { message.error(String(e)) } }
async function saveBrand() { try { await http.patch('/settings/share-brand', brand.value); message.success('品牌设置已保存') } catch (e) { message.error(String(e)) } }
onMounted(async () => { await load(); try { brand.value = await http.get('/public/brand') } catch (e) { error.value = String(e) } })
</script>
<template><section class="module-page"><div class="module-heading"><div><div class="eyebrow">SYSTEM PREFERENCES</div><h1>安全与设置</h1><p>只有一个管理员，所有控制都在这里。</p></div></div><n-alert v-if="error" type="error">{{ error }}</n-alert>
  <n-tabs v-model:value="tab" type="line" animated size="large" pane-wrapper-class="settings-panes" class="settings-tabs">
    <n-tab-pane name="account" display-directive="show:lazy"><template #tab><span role="tab" :aria-selected="tab === 'account'">{{ '账号安全' }}</span></template>
      <div class="resource-grid"><article class="card"><h2>密码与双因素认证</h2><form class="module-form" @submit.prevent="changePassword"><label>当前密码<n-input v-model:value="password" type="password" :input-props="{ 'aria-label': '当前密码', autocomplete: 'current-password' }" /></label><label>新密码<n-input v-model:value="nextPassword" type="password" :input-props="{ 'aria-label': '新密码', autocomplete: 'new-password' }" /></label><label>TOTP 验证码<n-input v-model:value="code" :input-props="{ 'aria-label': 'TOTP 验证码', inputmode: 'numeric' }" /></label><div class="resource-actions"><n-button attr-type="submit" type="primary">修改密码并退出所有会话</n-button><n-button type="info" @click="setup">生成 TOTP 设置密钥</n-button></div><template v-if="seed"><p>将此密钥录入验证器，仅在本次展示。</p><code class="secret-value">{{ seed }}</code><n-button type="success" @click="factor('enable')">确认启用 TOTP</n-button></template><div class="resource-actions"><n-button quaternary type="error" @click="factor('disable')">停用 TOTP</n-button></div></form></article>
      <article class="card"><h2>分享页品牌</h2><form class="module-form" @submit.prevent="saveBrand"><label>标题<n-input v-model:value="brand.title" /></label><label>Logo（PNG/JPEG data URL，最大 192 KiB）<n-input v-model:value="brand.logo" :input-props="{ 'aria-label': '品牌 Logo 地址', maxlength: 262144 }" /></label><label>分享页背景<select v-model="brand.pageBackground" aria-label="分享页背景"><option value="bg">默认背景</option><option value="bg-soft">柔和背景</option></select></label><label>分享卡片背景<select v-model="brand.cardBackground" aria-label="分享卡片背景"><option value="surface">默认卡片</option><option value="surface-2">次级卡片</option></select></label><label>副标题<n-input v-model:value="brand.subtitle" /></label><label>页脚<n-input v-model:value="brand.footer" /></label><label><input v-model="brand.poweredBy" type="checkbox" />显示 UFM 署名</label><n-button type="primary" attr-type="submit">保存品牌</n-button></form></article></div>
    </n-tab-pane>
    <n-tab-pane name="notifications" display-directive="show:lazy"><template #tab><span role="tab" :aria-selected="tab === 'notifications'">{{ '通知与显示' }}</span></template>
      <notification-channels />
      <display-preferences />
    </n-tab-pane>
    <n-tab-pane name="system" display-directive="show:lazy"><template #tab><span role="tab" :aria-selected="tab === 'system'">{{ '系统与生命周期' }}</span></template>
      <global-settings />
      <lifecycle-settings />
      <system-status />
    </n-tab-pane>
    <n-tab-pane name="sessions" display-directive="show:lazy"><template #tab><span role="tab" :aria-selected="tab === 'sessions'">{{ '登录会话' }}</span></template>
      <article class="card"><div class="card-head"><h2>登录会话</h2><n-button @click="load">刷新会话</n-button></div><div v-for="session in sessions" :key="session.id" class="upload-status"><div><strong>{{ session.userAgent || '未知设备' }}</strong><p class="muted">{{ session.current ? '当前会话' : '其他会话' }} · {{ session.expiresAt }}</p></div><n-button @click="revoke(session.id)">撤销会话</n-button></div></article>
    </n-tab-pane>
  </n-tabs>
  </section></template>
