<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, useMessage } from 'naive-ui'
import { http } from '@/api/http'
import { useAuthStore } from '@/stores/auth'
import { cards, preference } from '@/composables/displayPreferences'
import { refreshUnread, safeNoticeHref } from '@/composables/notificationInbox'
import { bytes as formatBytes } from '@/composables/format'
interface Project { id: string; name: string; usedFiles: number; usedBytes: number }
interface Notice { id: string; title: string; body: string; href?: string; readAt?: string }
interface Recent { id: string; originalName: string }
interface Share { id: string; token: string; enabled: boolean; downloadCount: number }
interface Storage { id: string; name: string; bytes: number | null; source: string; quotaBytes: number }
const layout = ref(cards.map(value => value.id))
const shares = ref<Share[]>([])
const folders = ref<{ id: string; path: string }[]>([])
const storages = ref<Storage[]>([])
const daily = ref<{ day: string; downloads: number }[]>([])
const projects = ref<Project[]>([])
const notifications = ref<Notice[]>([])
const recent = ref<Recent[]>([])
const shareCount = ref(0)
const taskCount = ref(0)
const error = ref('')
const auth = useAuthStore()
const message = useMessage()
const totalFiles = computed(() => projects.value.reduce((sum, p) => sum + (p.usedFiles || 0), 0))
const totalBytes = computed(() => projects.value.reduce((sum, p) => sum + (p.usedBytes || 0), 0))
async function load() {
  try {
    layout.value = await preference('workbench', cards)
    const [p, n, s, t] = await Promise.all([http.get<{ items: Project[] }>('/projects'), http.get<{ items: Notice[] }>('/notifications'), http.get<{ items: unknown[] }>('/shares'), http.get<{ items: { status: string }[] }>('/tasks')])
    projects.value = p.items; notifications.value = n.items; shareCount.value = s.items.length; taskCount.value = t.items.filter(i => ['RUNNING', 'PENDING'].includes(i.status)).length
    if (p.items[0]) recent.value = (await http.get<{ items: Recent[] }>('/files', { query: { projectId: p.items[0].id, size: 8 } })).items
    shares.value = (s.items as Share[]).slice(0, 8)
    if (p.items[0]) {
      const projectId = p.items[0].id
      folders.value = (await http.get<{ items: typeof folders.value }>('/folders/tree', { query: { projectId } })).items.slice(0, 8)
      const stats = (await http.get<{ items: { day: string; download_count: number }[] }>('/download-stats/daily', { query: { projectId } })).items
      const aggregated = new Map<string, number>()
      for (const row of stats) aggregated.set(row.day, (aggregated.get(row.day) ?? 0) + Number(row.download_count))
      daily.value = [...aggregated].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([day, downloads]) => ({ day, downloads }))
    }
    const storageRows = (await http.get<{ items: { id: string; name: string }[] }>('/storages')).items.slice(0, 20)
    storages.value = await Promise.all(storageRows.map(async row => {
      const [usage, policy] = await Promise.all([http.get<{ usedBytes?: number; source: string }>(`/storages/${row.id}/usage`), http.get<{ storageQuotaBytes: number }>(`/storages/${row.id}/policy`)])
      return { ...row, bytes: typeof usage.usedBytes === 'number' ? usage.usedBytes : null, source: usage.source, quotaBytes: policy.storageQuotaBytes ?? 0 }
    }))
  } catch (e) { error.value = String(e) }
}
async function readAll() { try { await http.post('/notifications/read-all'); await Promise.all([load(), refreshUnread()]) } catch (e) { message.error(String(e)) } }
async function read(notice: Notice) { try { await http.post(`/notifications/${notice.id}/read`); notice.readAt = new Date().toISOString(); await refreshUnread() } catch (e) { message.error(String(e)) } }
onMounted(load)
function percent(storage: Storage) { return storage.bytes === null || storage.quotaBytes <= 0 ? 0 : Math.min(100, storage.bytes / storage.quotaBytes * 100) }
const maxDownloads = computed(() => Math.max(1, ...daily.value.map(value => value.downloads)))
</script>
<template>
  <section class="module-page">
    <div class="card-hero"><div class="eyebrow">YOUR FILES, IN FOCUS</div><h1 class="page-title">{{ auth.user?.displayName || '管理员' }}，一切尽在掌握。</h1><p class="page-subtitle">存储、内容与分发，从一个清晰的工作台开始。</p><div class="resource-actions"><router-link class="btn btn-primary" to="/files">进入文件空间</router-link><n-button @click="load">刷新工作台</n-button><router-link to="/settings">自定义工作台</router-link></div></div>
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <div class="overview-metrics"><article v-for="metric in [{ label: '文件总数', value: totalFiles }, { label: '逻辑用量 / B', value: totalBytes }, { label: '文件分享', value: shareCount }, { label: '待处理任务', value: taskCount }]" :key="metric.label" class="card"><div class="eyebrow">{{ metric.label }}</div><strong>{{ metric.value }}</strong></article></div>
    <div class="resource-grid"><article v-for="card in layout" :key="card" class="card" :data-workbench-card="card">
      <template v-if="card === 'recent'"><div class="card-head"><h2>最近上传</h2><router-link to="/files">查看全部</router-link></div><p class="muted">{{ projects[0]?.name }} · 最近 8 项</p><div v-if="!recent.length" class="empty-state">还没有文件，上传你的第一份内容。</div><div v-for="file in recent" :key="file.id" class="upload-status"><span>{{ file.originalName }}</span></div></template>
      <template v-if="card === 'notifications'"><div class="card-head"><h2>通知</h2><n-button size="small" @click="readAll">全部标为已读</n-button></div><div v-if="!notifications.length" class="empty-state">暂无通知。</div><article v-for="notice in notifications" :key="notice.id" class="notice-item"><strong>{{ notice.title }}</strong><span v-if="!notice.readAt" class="badge">未读</span><p class="muted">{{ notice.body }}</p><div class="resource-actions"><n-button v-if="!notice.readAt" size="small" :aria-label="`标记已读 ${notice.title}`" @click="read(notice)">标记已读</n-button><router-link v-if="safeNoticeHref(notice.href)" :to="safeNoticeHref(notice.href)!" :aria-label="`查看通知详情 ${notice.title}`" @click="read(notice)">查看详情</router-link></div></article></template>
      <template v-if="card === 'projects'"><div class="card-head"><h2>项目概览</h2><router-link to="/projects">管理项目</router-link></div><div v-for="p in projects" :key="p.id" class="upload-status"><strong>{{ p.name }}</strong><span>{{ p.usedFiles }} 个文件 · {{ p.usedBytes }} B</span></div></template>
      <template v-if="card === 'shares'"><div class="card-head"><h2>我的分享</h2><router-link to="/shares">管理分享</router-link></div><div v-for="item in shares" :key="item.id" class="upload-status"><router-link :to="`/s/${encodeURIComponent(item.token)}`">{{ item.token }}</router-link><span>{{ item.enabled ? '分享中' : '已停用' }} · {{ item.downloadCount }} 次</span></div><p v-if="!shares.length" class="muted">暂无分享。</p></template>
      <template v-if="card === 'folders'"><h2>常用目录</h2><p class="muted">{{ projects[0]?.name }} · 项目目录快捷入口</p><div v-for="item in folders" :key="item.id" class="upload-status"><router-link :to="{ path: '/files', query: { project: projects[0]?.id, folder: item.path } }">{{ item.path }}</router-link></div><p v-if="!folders.length" class="muted">暂无目录。</p></template>
      <template v-if="card === 'storages'"><div class="card-head"><h2>存储用量</h2><router-link to="/storages">管理存储</router-link></div><div v-for="storage in storages" :key="storage.id" class="storage-overview"><svg class="usage-ring" viewBox="0 0 40 40" role="img" :aria-label="storage.bytes === null ? '未知用量' : `${storage.name} 已用 ${storage.bytes} 字节`"><circle class="usage-track" cx="20" cy="20" r="16" /><circle class="usage-value" cx="20" cy="20" r="16" pathLength="100" :stroke-dasharray="`${percent(storage)} 100`" /></svg><div><strong>{{ storage.name }}</strong><p class="muted">{{ storage.bytes === null ? '未知用量' : formatBytes(storage.bytes) }}<small v-if="storage.bytes !== null"> · {{ storage.source === 'manual' ? '手工填报' : '平台快照' }}{{ storage.quotaBytes > 0 ? ` / 额度 ${formatBytes(storage.quotaBytes)}` : ' / 未设置额度' }}</small></p></div></div><p v-if="!storages.length" class="muted">暂无存储。</p></template>
      <template v-if="card === 'trend'"><h2>下载趋势</h2><p class="muted">{{ projects[0]?.name }} · 最近 14 个有记录日 · 本站成功输出</p><div class="trend-chart" role="img" aria-label="每日成功下载趋势"><div v-for="day in daily" :key="day.day" class="trend-column"><span>{{ day.downloads }}</span><div class="trend-bar" :style="{ height: `${Math.max(2, day.downloads / maxDownloads * 100)}px` }" /><small>{{ day.day.slice(5) }}</small></div></div><p v-if="!daily.length" class="muted">暂无下载记录。</p></template>
    </article></div>
    <p v-if="!layout.length" class="muted">工作台卡片已隐藏，可在设置中重新启用。</p>
  </section>
</template>
