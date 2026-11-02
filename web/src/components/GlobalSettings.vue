<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NInput, useMessage } from 'naive-ui'
import { http } from '@/api/http'
const message = useMessage()
const error = ref('')
// 表单在服务端设置读取完成前不渲染：避免异步回填覆盖用户刚输入的数值。
const loaded = ref(false)
const settings = ref({ maxFileBytes: 5368709120, maxUploadFiles: 100, recycleDays: 30, forceHttps: false, allowedDomains: [] as string[], officePreviewUrl: '', downloadDomain: '' })
const domains = ref('')
async function save() {
  if (settings.value.forceHttps && location.protocol !== 'https:') { message.error('请先通过 HTTPS 打开系统，再启用强制 HTTPS，避免锁定访问。'); return }
  try {
    settings.value = await http.put('/settings/global', { ...settings.value, allowedDomains: domains.value.split(',').map(value => value.trim()).filter(Boolean) })
    domains.value = settings.value.allowedDomains.join(', '); message.success('全局设置已保存')
  } catch (e) { message.error(String(e)) }
}
onMounted(async () => {
  try { const result = await http.get<typeof settings.value>('/settings/global'); if (typeof result.maxFileBytes === 'number') settings.value = result; domains.value = settings.value.allowedDomains.join(', ') }
  catch (e) { error.value = String(e) }
  finally { loaded.value = true }
})
</script>
<template><article class="card"><h2>全局安全与上传</h2><p class="muted">服务端统一限制所有上传通道；中转上传仍受网关和服务器硬限制。新回收文件使用新的保留期限。</p><n-alert v-if="error" type="error">{{ error }}</n-alert><p v-if="!loaded" class="muted">正在读取服务端设置…</p><form v-else class="module-form" @submit.prevent="save"><label>单文件大小上限（字节）<input v-model.number="settings.maxFileBytes" type="number" min="1" max="5368709120" required aria-label="单文件大小上限（字节）" /></label><label>单次选择上传数量<input v-model.number="settings.maxUploadFiles" type="number" min="1" max="1000" required aria-label="单次选择上传数量" /></label><label>回收站保留天数<input v-model.number="settings.recycleDays" type="number" min="1" max="36500" required aria-label="回收站保留天数" /></label><label><input v-model="settings.forceHttps" type="checkbox" aria-label="强制 HTTPS" />强制 HTTPS（须先配置反向代理 TLS）</label><label>防盗链域名白名单<n-input v-model:value="domains" placeholder="逗号分隔，空为不限制" :input-props="{ 'aria-label': '防盗链域名白名单' }" /></label><label>Office 预览服务地址<n-input v-model:value="settings.officePreviewUrl" :input-props="{ 'aria-label': 'Office 预览服务地址' }" /></label><p class="muted">填写 KKFileView 兼容服务基址，留空则禁用 Office 在线预览；每次预览都需管理员显式确认，系统不会自动外发文件。</p><label>自定义下载域名<n-input v-model:value="settings.downloadDomain" placeholder="https://download.example" :input-props="{ 'aria-label': '自定义下载域名' }" /></label><n-button type="primary" attr-type="submit">保存全局设置</n-button></form></article></template>
