<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NDataTable, NInput, type DataTableColumns } from 'naive-ui'
import { http } from '@/api/http'
interface Record { id: string; action: string; ip?: string; actorId?: string; createdAt: string; detail: string }
const items = ref<Record[]>([]), action = ref(''), page = ref(0), total = ref(0), error = ref(''), busy = ref(false)
const retention = ref(180), deleted = ref<number | null>(null)
async function saveRetention() { try { await http.put('/audit-logs/retention', { days: retention.value }) } catch (e) { error.value = String(e) } }
async function cleanup() { try { deleted.value = (await http.post<{ deleted: number }>('/audit-logs/cleanup')).deleted; await load() } catch (e) { error.value = String(e) } }
const columns: DataTableColumns<Record> = [{ title: '时间', key: 'createdAt', width: 200 }, { title: '动作', key: 'action', minWidth: 240 }, { title: 'IP', key: 'ip', width: 140 }, { title: '结果与请求标识', key: 'detail', minWidth: 250, ellipsis: { tooltip: true } }]
async function load() {
  busy.value = true; error.value = ''
  try { const value = await http.get<{ items: Record[]; total: number }>('/audit-logs', { query: { action: action.value, page: page.value, size: 100 } }); items.value = value.items; total.value = value.total }
  catch (e) { error.value = String(e) } finally { busy.value = false }
}
async function exportCsv() {
  try {
    const data = await http.get<string>('/audit-logs/export', { query: { action: action.value } })
    const url = URL.createObjectURL(new Blob([data], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = 'ufm-audit.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (e) { error.value = String(e) }
}
onMounted(async () => { await load(); try { const result = await http.get<{ days: number }>('/audit-logs/retention'); if (typeof result.days === 'number') retention.value = result.days } catch (e) { error.value = String(e) } })
</script>
<template><section class="module-page"><div class="module-heading"><div><div class="eyebrow">SECURITY HISTORY</div><h1>审计日志</h1><p>只记录操作与结果，不记录密码、密钥或请求正文。</p></div><n-button @click="exportCsv">导出 CSV</n-button></div><n-alert v-if="error" type="error">{{ error }}</n-alert><article class="card"><h2>审计保留策略</h2><form class="module-form" @submit.prevent="saveRetention"><label>保留天数<input v-model.number="retention" type="number" min="1" max="36500" required aria-label="审计保留天数" /></label><div class="resource-actions"><n-button attr-type="submit">保存审计保留策略</n-button><n-button @click="cleanup">清理到期审计</n-button></div></form><p class="muted">Worker 每小时清理最多 10000 条到期记录，不删除保留期内记录；删除不可恢复，请先导出需长期归档的审计。</p><p v-if="deleted !== null">本次清理 {{ deleted }} 条</p></article><form class="file-toolbar module-form" @submit.prevent="page = 0; load()"><n-input v-model:value="action" placeholder="精确动作，如 POST /api/storages" :input-props="{ 'aria-label': '审计动作筛选' }" /><n-button type="primary" attr-type="submit">筛选审计</n-button></form><article class="card file-content"><n-data-table :columns="columns" :data="items" :loading="busy" :row-key="row => row.id" :scroll-x="830" /><div class="resource-actions"><n-button :disabled="page === 0 || busy" @click="page--; load()">上一页</n-button><span>第 {{ page + 1 }} 页 · 共 {{ total }} 条</span><n-button :disabled="(page + 1) * 100 >= total || busy" @click="page++; load()">下一页</n-button></div></article><p class="muted">CSV 最多导出最近 10000 条。失败操作同样留痕；审计数据库故障在服务日志报警。</p></section></template>
