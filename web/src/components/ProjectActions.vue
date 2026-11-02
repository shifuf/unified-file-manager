<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton, NInput, NModal, useMessage } from 'naive-ui'
import { http } from '@/api/http'
const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ saved: [] }>()
const open = ref(false), migrating = ref(false), error = ref(''), domains = ref(''), target = ref('')
const storages = ref<{ id: string; name: string }[]>([])
const project = ref({ name: '', description: '', quotaBytes: 0, quotaFiles: 0, allowedDomains: [] as string[] })
const message = useMessage()
const notifications = ref(true)
async function edit() {
  error.value = ''
  try { project.value = await http.get(`/projects/${props.projectId}`); notifications.value = (await http.get<{ enabled: boolean }>(`/projects/${props.projectId}/notification-settings`)).enabled; domains.value = project.value.allowedDomains.join(', '); open.value = true }
  catch (e) { message.error(String(e)) }
}
async function save() {
  try {
    const { name, description, quotaBytes, quotaFiles } = project.value
    await http.patch(`/projects/${props.projectId}`, { name, description, quotaBytes, quotaFiles, allowedDomains: [...new Set(domains.value.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))] })
    await http.put(`/projects/${props.projectId}/notification-settings`, { enabled: notifications.value })
    open.value = false; emit('saved')
  } catch (e) { error.value = String(e) }
}
async function migrate() {
  error.value = ''; target.value = ''
  try { storages.value = (await http.get<{ items: typeof storages.value }>('/storages')).items; migrating.value = true }
  catch (e) { message.error(String(e)) }
}
async function start() {
  try { await http.post('/tasks/migrations', { projectId: props.projectId, targetStorageId: target.value }); migrating.value = false; message.success('项目迁移已进入任务队列') }
  catch (e) { error.value = String(e) }
}
</script>
<template><n-button @click="edit">编辑项目</n-button><n-button @click="migrate">迁移项目文件</n-button><n-modal v-model:show="open" preset="card" title="编辑项目设置" class="module-dialog"><n-alert v-if="error" type="error">{{ error }}</n-alert><form class="module-form" @submit.prevent="save"><label>项目名称<n-input v-model:value="project.name" :input-props="{ 'aria-label': '编辑项目名称', maxlength: 128, required: true }" /></label><label>描述<n-input v-model:value="project.description" :input-props="{ 'aria-label': '编辑项目描述', maxlength: 4096 }" /></label><label>容量上限（0 不限）<input v-model.number="project.quotaBytes" aria-label="编辑容量上限" type="number" min="0" required /></label><label>数量上限（0 不限）<input v-model.number="project.quotaFiles" aria-label="编辑文件数量上限" type="number" min="0" required /></label><label>允许域名（逗号分隔）<n-input v-model:value="domains" :input-props="{ 'aria-label': '项目允许域名' }" /></label><label><input v-model="notifications" type="checkbox" aria-label="启用项目站内通知" />启用项目站内通知（不影响已订阅的外部推送）</label><n-button attr-type="submit" type="primary">保存项目设置</n-button></form></n-modal><n-modal v-model:show="migrating" preset="card" title="迁移项目文件" class="module-dialog"><n-alert v-if="error" type="error">{{ error }}</n-alert><div class="module-form"><label>目标存储<select v-model="target" aria-label="项目迁移目标"><option value="">请选择</option><option v-for="storage in storages" :key="storage.id" :value="storage.id">{{ storage.name }}</option></select></label><p>逐文件复制并校验后切换归属，保留原对象。不会切换项目上传绑定；后台任务可暂停或重试。</p><n-button type="primary" :disabled="!target" @click="start">创建项目迁移任务</n-button></div></n-modal></template>
