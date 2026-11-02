<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NButton, NModal, NInput, NAlert, useMessage } from 'naive-ui'
import { http } from '@/api/http'
import { bytes as formatBytes } from '@/composables/format'
interface Storage { id: string; name: string; provider: string; isDefault: boolean; enabled: boolean; config?: Record<string, string> }
interface Usage { source?: string; usedBytes?: number; checkedAt?: string }
const usages = ref<Record<string, Usage>>({})
const items = ref<Storage[]>([])
const open = ref(false)
const editing = ref('')
const name = ref('')
const basePath = ref('/data/files')
const provider = ref('LOCAL')
const endpoint = ref('')
const bucket = ref('')
const region = ref('us-east-1')
const accessKey = ref('')
const secretKey = ref('')
const rsEndpoint = ref('')
const uploadEndpoint = ref('')
const customDomain = ref('')
const privateSpace = ref(false)
const service = ref('')
const operator = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const message = useMessage()
interface Policy { priority: number; storageQuotaBytes: number; trafficQuotaBytes: number; threshold: number; autoFailover: boolean; manualStorageBytes?: number | null; manualTrafficBytes?: number | null }
const policyId = ref('')
const policyOpen = ref(false)
const policy = ref({ priority: '100', storageQuotaBytes: '0', trafficQuotaBytes: '0', threshold: '90', autoFailover: false, manualStorageBytes: '', manualTrafficBytes: '' })
const providerLabels: Record<string, string> = { LOCAL: '本地磁盘', S3: 'S3 兼容', QINIU: '七牛云 Kodo', UPYUN: '又拍云', OSS: '阿里云 OSS' }
const providerHints: Record<string, string> = {
  LOCAL: '写入服务器本机目录，适合单机部署。',
  S3: '兼容 AWS S3 协议的对象存储，含 MinIO、R2、COS、B2。',
  QINIU: '七牛云对象存储，1 GiB 以内浏览器直传，更大文件走服务端分块。',
  UPYUN: '又拍云对象存储，1 GiB 以内表单直传，更大文件走服务端分块。',
  OSS: '阿里云对象存储，浏览器直传需在空间配置 CORS 并暴露 ETag。',
}
function label(provider: string) { return providerLabels[provider] ?? provider }
function hint(provider: string) { return providerHints[provider] ?? '' }
function usageText(item: Storage) {
  const usage = usages.value[item.id]
  if (!usage || typeof usage.usedBytes !== 'number') return '未提供用量'
  return formatBytes(usage.usedBytes)
}
function usageSource(item: Storage) {
  const source = usages.value[item.id]?.source
  if (source === 'manual') return '手工填报'
  if (source === 'platform') return '平台用量'
  return '厂商未提供用量'
}
async function editPolicy(item: Storage) {
  try {
    const value = await http.get<Policy>(`/storages/${item.id}/policy`)
    policy.value = { priority: String(value.priority), storageQuotaBytes: String(value.storageQuotaBytes), trafficQuotaBytes: String(value.trafficQuotaBytes), threshold: String(value.threshold), autoFailover: value.autoFailover, manualStorageBytes: value.manualStorageBytes == null ? '' : String(value.manualStorageBytes), manualTrafficBytes: value.manualTrafficBytes == null ? '' : String(value.manualTrafficBytes) }
    policyId.value = item.id; error.value = ''; policyOpen.value = true
  } catch (e) { message.error(String(e)) }
}
async function savePolicy() {
  busy.value = true; error.value = ''
  try {
    const integer = (text: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
      const value = Number(text)
      if (!text.trim() || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('请输入范围内的整数，字节额度不得超过安全整数上限')
      return value
    }
    await http.put(`/storages/${policyId.value}/policy`, { priority: integer(policy.value.priority, -2147483648, 2147483647), storageQuotaBytes: integer(policy.value.storageQuotaBytes), trafficQuotaBytes: integer(policy.value.trafficQuotaBytes), threshold: integer(policy.value.threshold, 1, 100), autoFailover: policy.value.autoFailover, manualStorageBytes: policy.value.manualStorageBytes.trim() ? integer(policy.value.manualStorageBytes) : null, manualTrafficBytes: policy.value.manualTrafficBytes.trim() ? integer(policy.value.manualTrafficBytes) : null })
    policyOpen.value = false; await load()
  } catch (e) { error.value = String(e) } finally { busy.value = false }
}
async function load() {
  try {
    items.value = (await http.get<{ items: Storage[] }>('/storages')).items
    for (const item of items.value) {
      try { usages.value[item.id] = await http.get<Usage>(`/storages/${item.id}/usage`) }
      catch { usages.value[item.id] = { source: 'unknown' } }
    }
  } catch (e) { error.value = String(e) }
}
async function save() {
  busy.value = true; error.value = ''
  try {
    const config = draftConfig()
    if (editing.value) await http.patch(`/storages/${editing.value}`, { name: name.value, config })
    else await http.post('/storages', { name: name.value, provider: provider.value, config })
    open.value = false; secretKey.value = ''; accessKey.value = ''; password.value = ''; await load()
  } catch (e) { error.value = String(e) } finally { busy.value = false }
}
function draftConfig(): Record<string, unknown> {
  if (provider.value === 'LOCAL') return { basePath: basePath.value }
  if (provider.value === 'QINIU') {
    const config: Record<string, unknown> = { endpoint: endpoint.value, bucket: bucket.value, accessKey: accessKey.value, secretKey: secretKey.value, private: privateSpace.value }
    if (rsEndpoint.value.trim()) config.rsEndpoint = rsEndpoint.value.trim()
    if (uploadEndpoint.value.trim()) config.uploadEndpoint = uploadEndpoint.value.trim()
    if (customDomain.value.trim()) config.customDomain = customDomain.value.trim()
    return config
  }
  if (provider.value === 'UPYUN') {
    const config: Record<string, unknown> = { endpoint: endpoint.value, service: service.value, operator: operator.value, password: password.value }
    if (customDomain.value.trim()) config.customDomain = customDomain.value.trim()
    return config
  }
  return { endpoint: endpoint.value, bucket: bucket.value, region: region.value, accessKey: accessKey.value, secretKey: secretKey.value }
}
function create() { editing.value = ''; name.value = ''; provider.value = 'LOCAL'; basePath.value = '/data/files'; endpoint.value = ''; bucket.value = ''; accessKey.value = ''; secretKey.value = ''; rsEndpoint.value = ''; uploadEndpoint.value = ''; customDomain.value = ''; privateSpace.value = false; service.value = ''; operator.value = ''; password.value = ''; error.value = ''; open.value = true }
async function edit(item: Storage) {
  try {
    const value = await http.get<Storage>(`/storages/${item.id}/configuration`); const config = value.config ?? {}
    editing.value = value.id; name.value = value.name; provider.value = value.provider
    basePath.value = config.basePath ?? ''; endpoint.value = config.endpoint ?? ''; bucket.value = config.bucket ?? ''
    region.value = config.region ?? 'us-east-1'; accessKey.value = config.accessKey ?? '***'
    secretKey.value = config.secretKey ?? '***'
    rsEndpoint.value = config.rsEndpoint ?? ''; customDomain.value = config.customDomain ?? ''
    uploadEndpoint.value = config.uploadEndpoint ?? ''
    privateSpace.value = config.private === 'true'; service.value = config.service ?? ''
    operator.value = value.provider === 'UPYUN' ? '***' : ''
    password.value = value.provider === 'UPYUN' ? '***' : ''
    error.value = ''; open.value = true
  }
  catch (e) { message.error(String(e)) }
}
async function probeDraft() {
  try { await http.post('/storages/test-draft', { name: name.value, provider: provider.value, config: draftConfig() }); message.success('凭据校验通过：已成功写入并读取 1 KiB 探针文件') }
  catch (e) { message.error(String(e)) }
}
async function probe(item: Storage) { try { await http.post(`/storages/${item.id}/test`); message.success('连通测试通过：读写与删除探针均正常') } catch (e) { message.error(String(e)) } }
async function defaultStorage(item: Storage) { try { await http.post(`/storages/${item.id}/make-default`); message.success('已设为全局默认存储'); await load() } catch (e) { message.error(String(e)) } }
async function remove(item: Storage) {
  if (!confirm(`删除存储「${item.name}」？已上传的对象不会被清除，但项目将无法继续写入该存储。`)) return
  try { await http.delete(`/storages/${item.id}`); message.success('存储配置已删除'); await load() } catch (e) { message.error(String(e)) }
}
onMounted(load)
</script>

<template>
  <section class="module-page">
    <div class="module-heading"><div><div class="eyebrow">YOUR INFRASTRUCTURE</div><h1>连接你的存储</h1><p>凭据加密保存，文件始终由你掌控。</p></div><n-button type="primary" @click="create">添加存储</n-button></div>
    <n-alert v-if="error" type="error" :show-icon="false">{{ error }}</n-alert>
    <div v-if="!items.length" class="card empty-state"><h2>从一块本地磁盘开始</h2><p>也可以连接 S3 兼容存储。用量未知时不会误显示为零。</p></div>
    <div class="resource-grid"><article v-for="item in items" :key="item.id" class="card" :data-storage="item.id"><div class="card-head"><h2>{{ item.name }}</h2><span class="badge">{{ label(item.provider) }}</span></div>
      <p class="muted">{{ item.isDefault ? '全局默认存储，新建项目默认写入这里' : '独立存储配置，按项目绑定使用' }}</p><div class="resource-metrics"><span><strong>{{ usageText(item) }}</strong><small>{{ usageSource(item) }}</small></span><span><strong>已加密</strong>连接凭据</span></div>
      <div class="resource-actions"><n-button type="info" @click="probe(item)">连通测试</n-button><n-button @click="edit(item)">编辑存储</n-button><n-button @click="editPolicy(item)">用量与切换策略</n-button><n-button type="success" :disabled="item.isDefault" @click="defaultStorage(item)">{{ item.isDefault ? '当前默认' : '设为默认' }}</n-button><n-button quaternary type="error" @click="remove(item)">删除存储</n-button></div></article></div>
    <n-modal v-model:show="policyOpen" preset="card" title="用量与切换策略" class="module-dialog"><form class="module-form" @submit.prevent="savePolicy">
      <p class="muted">额度填 0 表示不限制。手工用量留空表示未知，不会被当成 0；优先级数值越小越先被使用。</p>
      <label>故障切换优先级（数值越小越优先）<n-input v-model:value="policy.priority" :input-props="{ 'aria-label': '优先级', inputmode: 'numeric' }" /></label>
      <label>存储空间额度（字节，0 为不限）<n-input v-model:value="policy.storageQuotaBytes" :input-props="{ 'aria-label': '存储空间额度字节', inputmode: 'numeric' }" /></label>
      <label>月度流量额度（字节，0 为不限）<n-input v-model:value="policy.trafficQuotaBytes" :input-props="{ 'aria-label': '流量额度字节', inputmode: 'numeric' }" /></label>
      <label>切换触发阈值（占额度的百分比，1–100）<n-input v-model:value="policy.threshold" :input-props="{ 'aria-label': '触发阈值百分比', inputmode: 'numeric' }" /></label>
      <label>手工填报已用空间（字节，留空为未知）<n-input v-model:value="policy.manualStorageBytes" placeholder="未知" :input-props="{ 'aria-label': '手工空间用量字节', inputmode: 'numeric' }" /></label>
      <label>手工填报已用流量（字节，留空为未知）<n-input v-model:value="policy.manualTrafficBytes" placeholder="未知" :input-props="{ 'aria-label': '手工流量用量字节', inputmode: 'numeric' }" /></label>
      <label class="field-help-row"><input v-model="policy.autoFailover" type="checkbox" aria-label="允许自动切换"><span>达到阈值时自动切换到下一个可用存储（需先在项目里绑定多个存储）</span></label>
      <n-alert v-if="error" type="error">{{ error }}</n-alert><n-button type="primary" attr-type="submit" :loading="busy">保存存储策略</n-button>
    </form></n-modal>
    <n-modal v-model:show="open" preset="card" :title="editing ? '编辑存储' : '添加存储'" class="module-dialog"><form class="module-form" @submit.prevent="save">
      <label>存储名称<n-input v-model:value="name" :input-props="{ 'aria-label': '存储名称', required: true }" /></label>
      <label>存储类型<select v-model="provider" aria-label="存储类型" :disabled="!!editing"><option value="LOCAL">本地磁盘</option><option value="S3">S3 兼容</option><option value="QINIU">七牛云 Kodo</option><option value="UPYUN">又拍云</option><option value="OSS">阿里云 OSS</option></select></label>
      <p v-if="!editing" class="muted">{{ hint(provider) }}</p>
      <label v-if="provider === 'LOCAL'">本地绝对路径<n-input v-model:value="basePath" :input-props="{ 'aria-label': '本地绝对路径', required: true }" /></label>
      <p v-if="provider === 'LOCAL'" class="muted">目录不存在时会自动创建；请填写运行 API 进程的机器上的绝对路径，相对路径会被拒绝。</p>
      <template v-else-if="provider === 'QINIU'"><p class="muted">七牛 Kodo 原生协议。Endpoint 填上传源站（如 https://upload.qiniup.com），Bucket 填空间名；1 GiB 以内由浏览器持有时效 uptoken 直传，更大的文件自动走服务端分块。直传需在空间配置 CORS 允许本站来源。私有空间需勾选私有并填写下载域名。</p>
        <label>Endpoint<n-input v-model:value="endpoint" placeholder="https://upload.qiniup.com" :input-props="{ required: true, 'aria-label': 'Endpoint' }" /></label>
        <label>上传域名<n-input v-model:value="uploadEndpoint" placeholder="https://upload.qiniup.com，留空使用 Endpoint" :input-props="{ 'aria-label': '上传域名' }" /></label>
        <label>管理接口地址<n-input v-model:value="rsEndpoint" placeholder="https://rs.qiniuapi.com，留空使用源站" :input-props="{ 'aria-label': '管理接口地址' }" /></label>
        <label>Bucket<n-input v-model:value="bucket" :input-props="{ required: true, 'aria-label': 'Bucket' }" /></label>
        <label>Access Key<n-input v-model:value="accessKey" :input-props="{ 'aria-label': 'Access Key' }" /></label>
        <label>Secret Key<n-input v-model:value="secretKey" type="password" :input-props="{ 'aria-label': 'Secret Key' }" /></label>
        <label>下载域名<n-input v-model:value="customDomain" placeholder="https://cdn.example.com，留空使用源站" :input-props="{ 'aria-label': '下载域名' }" /></label>
        <label><input v-model="privateSpace" type="checkbox" aria-label="私有空间">私有空间（下载直链带时效签名）</label></template>
      <template v-else-if="provider === 'UPYUN'"><p class="muted">又拍云 REST 原生协议。Endpoint 填源站（如 https://v0.api.upyun.com），服务名为存储空间；1 GiB 以内由浏览器持有时效表单授权直传，更大的文件自动走服务端分块。直传需在控制台配置 CORS 允许本站来源，私有防盗链同样在控制台配置。</p>
        <label>Endpoint<n-input v-model:value="endpoint" placeholder="https://v0.api.upyun.com" :input-props="{ required: true, 'aria-label': 'Endpoint' }" /></label>
        <label>服务名<n-input v-model:value="service" :input-props="{ required: true, 'aria-label': '服务名' }" /></label>
        <label>操作员<n-input v-model:value="operator" :input-props="{ 'aria-label': '操作员' }" /></label>
        <label>操作员密码<n-input v-model:value="password" type="password" :input-props="{ 'aria-label': '操作员密码' }" /></label>
        <label>下载域名<n-input v-model:value="customDomain" placeholder="https://cdn.example.com，留空使用源站" :input-props="{ 'aria-label': '下载域名' }" /></label></template>
      <template v-else><p v-if="provider === 'OSS'" class="muted">OSS V4 原生签名。Endpoint 填区域公共服务地址（不含 Bucket）；Region 如 cn-hangzhou，不能使用 S3 默认值。浏览器直传需配置 CORS 并暴露 ETag。</p><label>Endpoint<n-input v-model:value="endpoint" :input-props="{ required: true, 'aria-label': 'Endpoint' }" /></label><label>Bucket<n-input v-model:value="bucket" :input-props="{ 'aria-label': 'Bucket' }" /></label><label>Region<n-input v-model:value="region" :input-props="{ 'aria-label': 'Region' }" /></label><label>Access Key<n-input v-model:value="accessKey" :input-props="{ 'aria-label': 'Access Key' }" /></label><label>Secret Key<n-input v-model:value="secretKey" type="password" :input-props="{ 'aria-label': 'Secret Key' }" /></label></template>
      <n-alert v-if="error" type="error">{{ error }}</n-alert><n-button v-if="!editing" :disabled="!name" @click="probeDraft">测试当前配置</n-button><n-button type="primary" attr-type="submit" :loading="busy">保存存储</n-button>
    </form></n-modal>
  </section>
</template>
