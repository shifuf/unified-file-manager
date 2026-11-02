<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NModal, NInput, NInputNumber, NAlert, useMessage } from 'naive-ui'
import { http } from '@/api/http'
import ProjectWebDav from '@/components/ProjectWebDav.vue'
import UploadCredential from '@/components/UploadCredential.vue'
import ProjectActions from '@/components/ProjectActions.vue'
interface Project { id: string; name: string; description?: string; appId?: string; usedBytes?: number; usedFiles?: number }
interface Storage { id: string; name: string }
const projects = ref<Project[]>([])
const storages = ref<Storage[]>([])
const createOpen = ref(false)
const binding = ref<Project | null>(null)
const secret = ref('')
const selected = ref('')
const name = ref('')
const description = ref('')
const quotaBytes = ref(0)
const quotaFiles = ref(0)
const busy = ref(false)
const error = ref('')
const message = useMessage()
const packageOpen = ref(false)
const packageFile = ref<File | null>(null)
const packageStorage = ref('')
const packageBusy = ref(false)
async function load() { try { projects.value = (await http.get<{ items: Project[] }>('/projects')).items } catch (e) { error.value = String(e) } }
async function create() {
  busy.value = true; error.value = ''
  try {
    const result = await http.post<{ appSecret: string }>('/projects', { name: name.value, description: description.value, quotaBytes: quotaBytes.value, quotaFiles: quotaFiles.value, allowedDomains: [] })
    secret.value = result.appSecret; createOpen.value = false; name.value = ''; await load()
  } catch (e) { error.value = String(e) } finally { busy.value = false }
}
async function bind(project: Project) {
  try { storages.value = (await http.get<{ items: Storage[] }>('/storages')).items; binding.value = project; selected.value = storages.value[0]?.id ?? '' }
  catch (e) { message.error(String(e)) }
}
async function saveBinding() {
  if (!binding.value || !selected.value) return
  try {
    await http.post(`/projects/${binding.value.id}/storage-bindings`, { configId: selected.value, activate: true })
    binding.value = null; message.success('存储已绑定并激活')
  } catch (e) { message.error(String(e)) }
}
async function rotate(project: Project) {
  try { secret.value = (await http.post<{ appSecret: string }>(`/projects/${project.id}/secrets/rotate`)).appSecret }
  catch (e) { message.error(String(e)) }
}
async function remove(project: Project) {
  try { await http.delete(`/projects/${project.id}`); await load() } catch (e) { message.error(String(e)) }
}
async function exportProject(project: Project) {
  try {
    const blob = await http.blob(`/projects/${project.id}/export`)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ufm-project-${project.name}.zip`
    link.click()
    URL.revokeObjectURL(url)
    message.success('项目导出包已开始下载')
  } catch (e) { message.error(String(e)) }
}
async function openImport() {
  try {
    storages.value = (await http.get<{ items: Storage[] }>('/storages')).items
    packageStorage.value = storages.value[0]?.id ?? ''
    packageFile.value = null
    packageOpen.value = true
  } catch (e) { message.error(String(e)) }
}
function choosePackage(files: FileList | null) { packageFile.value = files?.[0] ?? null }
async function importPackage() {
  if (!packageFile.value || !packageStorage.value) return
  packageBusy.value = true
  try {
    const form = new FormData()
    form.append('file', packageFile.value)
    const result = await http.post<{ name: string; files: number }>(`/projects/import?storageId=${encodeURIComponent(packageStorage.value)}`, form, { timeout: 600_000 })
    packageOpen.value = false
    await load()
    message.success(`已导入 ${result.files} 个文件到「${result.name}」`)
  } catch (e) { message.error(String(e)) } finally { packageBusy.value = false }
}
import { bytes } from '@/composables/format'
onMounted(load)
</script>

<template>
  <section class="module-page">
    <div class="module-heading"><div><div class="eyebrow">ISOLATED SPACES</div><h1>项目空间</h1><p>把文件、配额与分发规则，组织在独立的空间里。</p></div><div class="resource-actions"><n-button @click="openImport">导入项目包</n-button><n-button type="primary" @click="createOpen = true">新建项目</n-button></div></div>
    <n-alert v-if="error" type="error" :show-icon="false">{{ error }}</n-alert>
    <div v-if="!projects.length" class="card empty-state"><h2>建立第一个项目</h2><p>项目是文件与统计的隔离边界。创建后绑定存储，即可开始上传。</p></div>
    <div class="resource-grid">
      <article v-for="project in projects" :key="project.id" class="card">
        <div class="card-head"><h2>{{ project.name }}</h2><span class="badge">PROJECT</span></div>
        <p class="muted">{{ project.description || '一个新的文件空间' }}</p><code>{{ project.appId }}</code>
        <div class="resource-metrics"><span><strong>{{ project.usedFiles ?? 0 }}</strong>文件</span><span><strong>{{ bytes(project.usedBytes) }}</strong>已使用</span></div>
        <div class="resource-actions"><n-button @click="bind(project)">绑定存储</n-button><n-button @click="rotate(project)">轮换密钥</n-button><n-button @click="exportProject(project)">导出项目</n-button><project-web-dav :project-id="project.id" /><upload-credential :project-id="project.id" /><project-actions :project-id="project.id" @saved="load" /><n-button quaternary type="error" @click="remove(project)">删除</n-button></div>
      </article>
    </div>
    <n-modal v-model:show="createOpen" preset="card" title="新建项目" class="module-dialog">
      <form class="module-form" @submit.prevent="create"><label>项目名称<n-input v-model:value="name" :input-props="{ 'aria-label': '项目名称', required: true }" /></label>
        <label>描述<n-input v-model:value="description" type="textarea" /></label>
        <label>容量上限（字节，0 不限）<n-input-number v-model:value="quotaBytes" :min="0" /></label>
        <label>文件数量上限（0 不限）<n-input-number v-model:value="quotaFiles" :min="0" /></label>
        <n-alert v-if="error" type="error">{{ error }}</n-alert><n-button type="primary" attr-type="submit" :loading="busy">创建项目</n-button>
      </form>
    </n-modal>
    <n-modal :show="!!secret" preset="card" title="请妥善保存项目密钥" class="module-dialog" :mask-closable="false" :closable="false">
      <p>此密钥仅在创建或轮换时显示。轮换后旧密钥立即失效。</p><code class="secret-value">{{ secret }}</code><n-button type="primary" block @click="secret = ''">我已妥善保存</n-button>
    </n-modal>
    <n-modal :show="!!binding" preset="card" title="绑定项目存储" class="module-dialog" @update:show="binding = null">
      <div class="module-form"><label>选择存储<select v-model="selected" aria-label="选择存储"><option v-for="storage in storages" :key="storage.id" :value="storage.id">{{ storage.name }}</option></select></label>
        <p>绑定后立即激活；现有文件仍保留在原存储，需要时从任务页发起迁移。</p><n-button type="primary" :disabled="!selected" @click="saveBinding">确认绑定</n-button></div>
    </n-modal>
    <n-modal v-model:show="packageOpen" preset="card" title="导入项目包" class="module-dialog">
      <div class="module-form">
        <p>导入会在目标存储上创建一个新项目，文件名、版本历史、标签与公开状态一并恢复；密钥不会复用。</p>
        <label>项目包（.zip）<input type="file" accept=".zip,application/zip" aria-label="选择项目包" @change="choosePackage(($event.target as HTMLInputElement).files)" /></label>
        <label>目标存储<select v-model="packageStorage" aria-label="导入目标存储"><option v-for="storage in storages" :key="storage.id" :value="storage.id">{{ storage.name }}</option></select></label>
        <n-button type="primary" :disabled="!packageFile || !packageStorage" :loading="packageBusy" @click="importPackage">确认导入</n-button>
      </div>
    </n-modal>
  </section>
</template>
