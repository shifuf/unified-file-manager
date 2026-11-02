<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton, NInput, NModal } from 'naive-ui'
import { http } from '@/api/http'
const props = defineProps<{ projectId: string }>()
const open = ref(false), token = ref(''), folder = ref('/'), extensions = ref(''), error = ref(''), busy = ref(false)
const maxBytes = ref(104857600), maxFiles = ref(10), maxFileBytes = ref(10485760), ttl = ref(600)
interface Credential { id: string; maxFiles: number; usedFiles: number; maxBytes: number; usedBytes: number; expiresAt: string; revokedAt?: string }
const credentials = ref<Credential[]>([])
async function load() { credentials.value = (await http.get<{ items: Credential[] }>('/upload-credentials', { query: { projectId: props.projectId } })).items }
async function manage() { open.value = true; token.value = ''; error.value = ''; try { await load() } catch (e) { error.value = String(e) } }
async function revoke(id: string) { try { await http.delete(`/upload-credentials/${id}`); await load() } catch (e) { error.value = String(e) } }
function close() { token.value = ''; open.value = false; error.value = '' }
async function generate() {
  busy.value = true; error.value = ''
  try {
    token.value = (await http.post<{ token: string }>('/upload-credentials', {
      projectId: props.projectId, folderPath: folder.value, maxBytes: maxBytes.value, maxFiles: maxFiles.value,
      maxFileBytes: maxFileBytes.value, ttlSeconds: ttl.value,
      allowedExtensions: [...new Set(extensions.value.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))],
    })).token
  } catch (e) { error.value = String(e) } finally { busy.value = false }
}
</script>
<template><n-button @click="manage">创建上传凭证</n-button><n-modal :show="open" preset="card" title="限定上传凭证" class="module-dialog" @update:show="close"><n-alert v-if="error" type="error">{{ error }}</n-alert><template v-if="token"><p>凭证只在本次展示。使用 X-Upload-Token 请求头上传到 /api/public/uploads/credential，不要将凭证放入 URL。</p><code class="secret-value">{{ token }}</code><n-button @click="close">关闭并清除凭证</n-button></template><form v-else class="module-form" @submit.prevent="generate"><label>限定目录<n-input v-model:value="folder" :input-props="{ 'aria-label': '凭证限定目录' }" /></label><label>总字节上限<input v-model.number="maxBytes" type="number" min="1" required aria-label="凭证总字节上限" /></label><label>文件数量<input v-model.number="maxFiles" type="number" min="1" required aria-label="凭证文件数量" /></label><label>单文件上限<input v-model.number="maxFileBytes" type="number" min="1" required aria-label="凭证单文件上限" /></label><label>有效秒数<input v-model.number="ttl" type="number" min="60" max="604800" required aria-label="凭证有效秒数" /></label><label>允许扩展名（逗号分隔，空为全部）<n-input v-model:value="extensions" :input-props="{ 'aria-label': '凭证扩展名' }" /></label><n-button type="primary" attr-type="submit" :loading="busy">生成限定上传凭证</n-button></form><div v-if="!token"><h3>最近上传凭证</h3><article v-for="credential in credentials" :key="credential.id" class="notice-item"><strong>{{ credential.usedFiles }} / {{ credential.maxFiles }} 个文件 · {{ credential.usedBytes }} / {{ credential.maxBytes }} B</strong><p class="muted">到期 {{ credential.expiresAt }}</p><span v-if="credential.revokedAt" class="badge">已撤销</span><n-button v-else @click="revoke(credential.id)">撤销此上传凭证</n-button></article><n-button @click="close">关闭上传凭证管理</n-button></div></n-modal></template>
