<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NModal, NInput, NAlert } from 'naive-ui'
import { http } from '@/api/http'
const props = defineProps<{ projectId: string }>()
const open = ref(false), enabled = ref(false), username = ref(''), password = ref(''), error = ref(''), busy = ref(false)
const address = `${location.origin}/dav/${props.projectId}/`
async function edit() {
  try { const value = await http.get<{ enabled: boolean; username: string }>(`/webdav/${props.projectId}`); enabled.value = value.enabled; username.value = value.username; password.value = ''; error.value = ''; open.value = true }
  catch (e) { error.value = String(e) }
}
async function save() {
  busy.value = true; error.value = ''
  try { await http.put(`/webdav/${props.projectId}`, { enabled: enabled.value, username: username.value, ...(password.value ? { password: password.value } : {}) }); password.value = ''; open.value = false }
  catch (e) { error.value = String(e) } finally { busy.value = false }
}
</script>
<template><n-button @click="edit">WebDAV 挂载</n-button><n-alert v-if="error && !open" type="error">{{ error }}</n-alert><n-modal v-model:show="open" preset="card" title="WebDAV 挂载" class="module-dialog" @after-leave="password = ''"><form class="module-form" @submit.prevent="save"><label><input v-model="enabled" type="checkbox" aria-label="启用 WebDAV">启用 WebDAV</label><label>挂载地址<n-input :value="address" readonly :input-props="{ 'aria-label': '挂载地址' }" /></label><label>WebDAV 账号<n-input v-model:value="username" :input-props="{ 'aria-label': 'WebDAV 账号', required: true, autocomplete: 'off' }" /></label><label>WebDAV 密码<n-input v-model:value="password" type="password" placeholder="留空保留原密码" :input-props="{ 'aria-label': 'WebDAV 密码', autocomplete: 'new-password' }" /></label><p class="muted">密码以 BCrypt 单向哈希保存，不可找回。至少 10 字符并包含数字。生产环境必须使用 HTTPS，挂载账号仅能访问此项目。</p><n-alert v-if="error" type="error">{{ error }}</n-alert><n-button attr-type="submit" type="primary" :loading="busy">保存 WebDAV</n-button></form></n-modal></template>
