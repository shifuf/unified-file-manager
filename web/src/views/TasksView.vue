<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NAlert, NButton, NProgress, useMessage } from 'naive-ui'
import { http } from '@/api/http'
interface Task { id: string; type: string; status: string; progress: number; attempts: number; error?: string; result?: { processed: number; succeeded: number; failed: number; truncated?: boolean; failures?: { fileId: string; name: string; code: string }[] } }
const items = ref<Task[]>([])
const error = ref('')
const message = useMessage()
let timer: ReturnType<typeof setInterval> | undefined
async function load() { try { items.value = (await http.get<{ items: Task[] }>('/tasks')).items; error.value = '' } catch (e) { error.value = String(e) } }
async function action(id: string, name: string) { try { await http.post(`/tasks/${id}/${name}`); await load() } catch (e) { message.error(String(e)) } }
onMounted(() => { load(); timer = setInterval(load, 5000) })
onUnmounted(() => clearInterval(timer))
</script>
<template><section class="module-page"><div class="module-heading"><div><div class="eyebrow">BACKGROUND OPERATIONS</div><h1>任务中心</h1><p>持久化队列，随时暂停与恢复。每 5 秒刷新。</p></div><n-button @click="load">刷新任务</n-button></div><n-alert v-if="error" type="error">{{ error }}</n-alert>
  <div v-if="!items.length" class="card empty-state">当前没有后台任务。</div><article v-for="task in items" :key="task.id" class="card"><div class="card-head"><h2>{{ task.type }}</h2><span class="badge">{{ task.status }}</span></div><p class="muted break-word">{{ task.id }} · 尝试 {{ task.attempts }} 次</p><n-progress type="line" :percentage="task.progress" /><p v-if="task.result?.processed !== undefined">已处理 {{ task.result.processed }} 项 · 成功 {{ task.result.succeeded }} 项 · 失败 {{ task.result.failed }} 项</p><n-alert v-if="task.error" type="error">{{ task.error }}</n-alert><div v-if="task.result?.failures?.length"><h3>失败文件</h3><p class="muted">重试仅重新处理尚未迁移的文件，原存储对象保留。</p><article v-for="failure in task.result.failures" :key="failure.fileId" class="notice-item break-word"><strong>{{ failure.name }}</strong><p>{{ failure.fileId }}</p><span class="badge">{{ failure.code }}</span></article><p v-if="task.result.truncated" class="muted">仅展示前 1000 项失败明细；完整失败数量见汇总。</p></div><div class="resource-actions"><n-button v-if="['RUNNING', 'PENDING'].includes(task.status)" @click="action(task.id, 'pause')">暂停</n-button><n-button v-if="task.status === 'PAUSED'" @click="action(task.id, 'resume')">继续</n-button><n-button v-if="['FAILED', 'CANCELED'].includes(task.status)" @click="action(task.id, 'retry')">重试</n-button><n-button v-if="['RUNNING', 'PENDING', 'PAUSED'].includes(task.status)" @click="action(task.id, 'cancel')">取消</n-button></div></article></section></template>
