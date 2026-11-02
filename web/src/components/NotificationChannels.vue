<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NInput, NModal, useMessage } from 'naive-ui'
import { http } from '@/api/http'
interface Channel { id: string; name: string; type: string; enabled: boolean; events: string[] }
interface Delivery { id: string; event: string; success: boolean; statusCode?: number; error?: string; createdAt?: string }
const items = ref<Channel[]>([])
const deliveries = ref<Delivery[]>([])
const show = ref(false)
const name = ref('')
const endpoint = ref('')
const secret = ref('')
const type = ref('WEBHOOK')
const events = ref(['FILE_UPLOADED'])
const editing = ref('')
const enabled = ref(true)
const message = useMessage()
const supported = ['FILE_UPLOADED', 'FILE_DELETED', 'SHARE_DOWNLOADED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'STORAGE_FAILED']
async function load() { try { items.value = (await http.get<{ items: Channel[] }>('/notify-channels')).items } catch (e) { message.error(String(e)) } }
async function create() {
  try {
    const input = { name: name.value, endpoint: endpoint.value, ...(secret.value ? { secret: secret.value } : {}), type: type.value, events: events.value, enabled: enabled.value }
    if (editing.value) await http.patch(`/notify-channels/${editing.value}`, input)
    else await http.post('/notify-channels', input)
    editing.value = ''; secret.value = ''; name.value = ''; endpoint.value = ''; enabled.value = true; await load(); message.success('通知渠道已保存')
  } catch (e) { message.error(String(e)) }
}
async function edit(item: Channel) {
  try {
    const value = await http.get<{ channel: Channel; endpoint: string }>(`/notify-channels/${item.id}/configuration`)
    editing.value = item.id; name.value = value.channel.name; type.value = value.channel.type; events.value = [...value.channel.events]; enabled.value = value.channel.enabled; endpoint.value = value.endpoint; secret.value = ''
  } catch (e) { message.error(String(e)) }
}
async function test(item: Channel) { try { await http.post(`/notify-channels/${item.id}/test`); message.success('测试通知已进入队列') } catch (e) { message.error(String(e)) } }
async function log(item: Channel) { try { deliveries.value = (await http.get<{ items: Delivery[] }>(`/notify-channels/${item.id}/deliveries`)).items; show.value = true } catch (e) { message.error(String(e)) } }
async function remove(item: Channel) { try { await http.delete(`/notify-channels/${item.id}`); await load() } catch (e) { message.error(String(e)) } }
onMounted(load)
</script>
<template><article class="card"><div class="card-head"><h2>通知与 Webhook</h2><n-button @click="load">刷新渠道</n-button></div><p class="muted">密钥仅写入，不回显。事件投递使用独立 Worker，失败自动重试。</p><form class="module-form" @submit.prevent="create"><label>渠道名称<n-input v-model:value="name" :input-props="{ 'aria-label': '通知渠道名称', required: true }" /></label><label>类型<select v-model="type" aria-label="通知渠道类型" :disabled="!!editing"><option value="WEBHOOK">签名 Webhook</option><option value="PUSH_PLATFORM">自建推送平台</option></select></label><label>Endpoint<n-input v-model:value="endpoint" :input-props="{ 'aria-label': '通知 Endpoint', required: true }" /></label><label>签名密钥 / API Key<n-input v-model:value="secret" type="password" :input-props="{ 'aria-label': '通知签名密钥', required: !editing, autocomplete: 'off' }" /></label><label><input v-model="enabled" type="checkbox" aria-label="启用通知渠道">启用通知渠道</label><fieldset class="event-options"><legend>订阅事件</legend><label v-for="event in supported" :key="event"><input v-model="events" type="checkbox" :value="event" />{{ event }}</label></fieldset><n-button attr-type="submit" type="primary">{{ editing ? '保存通知渠道' : '添加通知渠道' }}</n-button><n-button v-if="editing" tertiary @click="editing = ''; name = ''; secret = ''; endpoint = ''; enabled = true">取消编辑</n-button></form><article v-for="item in items" :key="item.id" class="notice-item"><div class="card-head"><strong>{{ item.name }}</strong><span class="badge">{{ item.type }}</span></div><p class="muted break-word">{{ item.events.join(' / ') }}</p><div class="resource-actions"><n-button @click="edit(item)">编辑通知渠道</n-button><n-button type="info" @click="test(item)">发送测试通知</n-button><n-button @click="log(item)">投递记录</n-button><n-button quaternary type="error" @click="remove(item)">删除渠道</n-button></div></article><n-modal v-model:show="show" preset="card" title="通知投递记录" class="module-dialog"><div v-for="item in deliveries" :key="item.id" class="upload-status"><span>{{ item.event }} · {{ item.success ? '成功' : '失败' }}</span><strong>{{ item.statusCode ?? '网络异常' }}</strong><span>{{ item.error }}</span></div><p v-if="!deliveries.length" class="muted">尚无投递记录，请稍后刷新。</p></n-modal></article></template>
