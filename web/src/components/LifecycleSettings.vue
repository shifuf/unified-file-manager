<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NInput, useMessage } from 'naive-ui'
import { http } from '@/api/http'
interface Policy { id: string; projectId: string; folderPath: string; days: number; enabled: boolean; category: string | null }
const items = ref<Policy[]>([]), projects = ref<{ id: string; name: string }[]>([])
const projectId = ref(''), folderPath = ref('/'), category = ref(''), days = ref('30'), error = ref('')
const message = useMessage()
async function load() { items.value = (await http.get<{ items: Policy[] }>('/lifecycle')).items }
async function create() {
  try {
    const count = Number(days.value)
    if (!Number.isInteger(count) || count < 1 || count > 36500) throw new Error('天数必须是 1 至 36500 的整数')
    await http.post('/lifecycle', { projectId: projectId.value, folderPath: folderPath.value, category: category.value || null, days: count, enabled: true }); await load()
  } catch (e) { error.value = String(e) }
}
async function toggle(policy: Policy) { try { await http.put(`/lifecycle/${policy.id}`, { ...policy, enabled: !policy.enabled }); await load() } catch (e) { error.value = String(e) } }
async function run(policy: Policy) { try { await http.post(`/lifecycle/${policy.id}/run`); message.success('生命周期任务已进入队列') } catch (e) { error.value = String(e) } }
async function remove(policy: Policy) { try { await http.delete(`/lifecycle/${policy.id}`); await load() } catch (e) { error.value = String(e) } }
onMounted(async () => { try { projects.value = (await http.get<{ items: typeof projects.value }>('/projects')).items; projectId.value = projects.value[0]?.id ?? ''; await load() } catch (e) { error.value = String(e) } })
</script>
<template><article class="card"><h2>生命周期策略</h2><p class="muted">只将符合目录、类别与上传天数的文件移入回收站，不立即物理删除。</p><n-alert v-if="error" type="error">{{ error }}</n-alert><form class="module-form" @submit.prevent="create"><label>项目<select v-model="projectId" aria-label="生命周期项目"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label><label>目录<n-input v-model:value="folderPath" :input-props="{ 'aria-label': '生命周期目录' }" /></label><label>文件类别<select v-model="category" aria-label="生命周期类别"><option value="">全部类别</option><option v-for="value in ['IMAGE', 'VIDEO', 'AUDIO', 'ARCHIVE', 'DOCUMENT', 'CODE', 'OTHER']" :key="value" :value="value">{{ value }}</option></select></label><label>上传后天数<n-input v-model:value="days" :input-props="{ 'aria-label': '生命周期天数', inputmode: 'numeric' }" /></label><n-button attr-type="submit" type="primary" :disabled="!projectId">创建生命周期策略</n-button></form><div v-for="policy in items" :key="policy.id" class="upload-status"><div><strong>{{ policy.category || '全部类别' }} · {{ policy.folderPath }} · {{ policy.days }} 天</strong><p class="muted">{{ policy.enabled ? '已启用' : '已暂停' }}</p></div><div class="resource-actions"><n-button :type="policy.enabled ? 'warning' : 'success'" @click="toggle(policy)">{{ policy.enabled ? '暂停策略' : '启用策略' }}</n-button><n-button type="info" :disabled="!policy.enabled" @click="run(policy)">立即执行策略</n-button><n-button quaternary type="error" @click="remove(policy)">删除策略</n-button></div></div></article></template>
