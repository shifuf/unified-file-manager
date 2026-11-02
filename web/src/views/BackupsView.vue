<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NInput, NModal, useMessage } from 'naive-ui'
import { http } from '@/api/http'
import RemoteBackup from '@/components/RemoteBackup.vue'
import { bytes } from '@/composables/format'
interface Backup { id: string; status: string; fileName: string; size?: number; checksum?: string; includeObjects: boolean; error?: string }
const items = ref<Backup[]>([])
const error = ref('')
const restoring = ref<Backup | null>(null)
const confirmation = ref('')
const message = useMessage()
const importing = ref(false)
function size(value?: number) { return bytes(value ?? null) }
async function importBackup(files: FileList | null) {
  const file = files?.[0]; if (!file) return
  importing.value = true
  try { const form = new FormData(); form.append('file', file); await http.post('/backups/import', form, { timeout: 600_000 }); await load(); message.success('备份完整性与签名验证通过') }
  catch (e) { message.error(String(e)) } finally { importing.value = false }
}
async function remove(item: Backup) {
  if (!window.confirm('确认删除此备份包？不会删除当前文件，但该恢复副本将不可用。')) return
  try { await http.delete(`/backups/${item.id}`); await load() } catch (e) { message.error(String(e)) }
}
async function load() { try { items.value = (await http.get<{ items: Backup[] }>('/backups')).items } catch (e) { error.value = String(e) } }
async function create() { try { await http.post('/backups', { includeObjects: true }); message.success('备份任务已进入队列'); await load() } catch (e) { message.error(String(e)) } }
async function restore() { if (!restoring.value) return; try { await http.post(`/backups/${restoring.value.id}/restore`, { confirmation: confirmation.value }); restoring.value = null; message.success('恢复任务已进入队列') } catch (e) { message.error(String(e)) } }
async function download(item: Backup) {
  try { const ticket = await http.post<{ url: string }>(`/backups/${item.id}/download-ticket`); const link = document.createElement('a'); link.href = ticket.url; link.download = item.fileName; link.click() } catch (e) { message.error(String(e)) }
}
onMounted(load)
</script>
<template><section class="module-page"><div class="module-heading"><div><div class="eyebrow">RECOVERY & CONTINUITY</div><h1>备份与恢复</h1><p>数据库与对象文件一起保存，恢复前验证完整性。</p></div><div class="resource-actions"><label class="upload-control">导入备份包<input type="file" accept=".zip,application/zip" aria-label="导入备份包" :disabled="importing" @change="importBackup(($event.target as HTMLInputElement).files)" /></label><n-button @click="load">刷新</n-button><n-button type="primary" @click="create">创建完整备份</n-button></div></div><n-alert v-if="error" type="error">{{ error }}</n-alert><n-alert type="warning" :show-icon="false">恢复会替换系统数据。请先停止其他写入，并保留当前数据库与对象目录的独立副本。</n-alert>
  <remote-backup @imported="load" />
  <div v-if="!items.length" class="card empty-state">尚无备份，立即创建第一份可恢复副本。</div><div class="resource-grid"><article v-for="item in items" :key="item.id" class="card"><div class="card-head"><h2>{{ item.fileName }}</h2><span class="badge">{{ item.status }}</span></div><p class="muted">{{ item.includeObjects ? '数据库 + 文件对象' : '仅数据库' }} · {{ size(item.size) }}</p><code class="secret-value">{{ item.checksum || '等待生成完整性校验' }}</code><n-alert v-if="item.error" type="error">{{ item.error }}</n-alert><div class="resource-actions"><n-button type="info" :disabled="item.status !== 'DONE'" @click="download(item)">下载备份</n-button><n-button type="warning" :disabled="item.status !== 'DONE'" @click="restoring = item; confirmation = ''">恢复备份</n-button><n-button quaternary type="error" :disabled="item.status === 'RUNNING'" @click="remove(item)">删除备份包</n-button></div></article></div>
  <n-modal :show="!!restoring" preset="card" title="确认系统恢复" class="module-dialog" @update:show="restoring = null"><div class="module-form"><p>此操作会覆盖系统数据库。输入 RESTORE 确认。</p><n-input v-model:value="confirmation" :input-props="{ 'aria-label': '恢复确认' }" /><n-button type="primary" :disabled="confirmation !== 'RESTORE'" @click="restore">确认恢复</n-button></div></n-modal></section></template>
