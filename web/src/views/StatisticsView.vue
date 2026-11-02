<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import { http } from '@/api/http'
const projects = ref<{ id: string; name: string }[]>([])
const project = ref('')
const summary = ref({ downloads: 0, bytes: 0 })
const daily = ref<{ day: string; source: string; download_count: number; bytes_sent: number }[]>([])
const bans = ref<{ ip: string; reason: string; permanent: boolean }[]>([])
const error = ref('')
const source = ref('')
const successful = ref('')
const page = ref(0)
const total = ref(0)
const records = ref<{ id: string; source: string; ip: string; bytesSent: number; success: boolean; failureReason?: string; createdAt: string }[]>([])
const top = ref<{ fileId: string; name: string; downloads: number; bytes: number }[]>([])
const access = ref<{ day: string; fileId: string; refererHost: string; accessCount: number }[]>([])
const ips = ref<{ ip: string; downloadCount: number; rateLimitCount: number; lastAccessAt: string }[]>([])
async function loadRecords() { if (!project.value) return; try { const result = await http.get<{ items: typeof records.value; total: number }>('/download-stats/list', { query: { projectId: project.value, page: page.value, size: 50, ...(source.value ? { source: source.value } : {}), ...(successful.value ? { success: successful.value } : {}) } }); records.value = result.items; total.value = result.total } catch (e) { error.value = String(e) } }
function filter() { page.value = 0; void loadRecords() }
async function paginate(delta: number) { page.value += delta; await loadRecords() }
async function load() { if (!project.value) return; try { error.value = ''; summary.value = await http.get('/download-stats/summary', { query: { projectId: project.value } }); daily.value = (await http.get<{ items: typeof daily.value }>('/download-stats/daily', { query: { projectId: project.value } })).items; bans.value = (await http.get<{ items: typeof bans.value }>('/ip-stats')).items; top.value = (await http.get<{ items: typeof top.value }>('/download-stats/top', { query: { projectId: project.value } })).items; access.value = (await http.get<{ items: typeof access.value }>('/download-stats/access', { query: { projectId: project.value } })).items; ips.value = (await http.get<{ items: typeof ips.value }>('/ip-stats/ledger')).items; page.value = 0; await loadRecords() } catch (e) { error.value = String(e) } }
async function unban(ip: string) { try { await http.delete('/ip-stats/ban', { query: { ip } }); await load() } catch (e) { error.value = String(e) } }
onMounted(async () => { try { projects.value = (await http.get<{ items: typeof projects.value }>('/projects')).items; project.value = projects.value[0]?.id ?? ''; await load() } catch (e) { error.value = String(e) } })
</script>
<template>
  <section class="module-page">
    <div class="module-heading"><div><div class="eyebrow">DELIVERY INSIGHTS</div><h1>分发统计与 IP 台账</h1><p>汇总仅计本站成功输出；云端重定向不计成功或流量，实际用量请核对平台账单。</p></div></div>
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <div class="module-form file-toolbar"><select v-model="project" aria-label="统计项目" @change="load"><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select><n-button @click="load">刷新统计</n-button></div>
    <div class="overview-metrics"><article class="card"><div class="eyebrow">成功输出</div><strong>{{ summary.downloads }}</strong></article><article class="card"><div class="eyebrow">输出字节数</div><strong>{{ summary.bytes }}</strong></article></div>
    <article class="card"><h2>每日分发</h2><div v-for="(day, i) in daily" :key="i" class="upload-status"><span>{{ day.day }} · {{ day.source }}</span><span>{{ day.download_count }} 次 · {{ day.bytes_sent }} B</span></div><p v-if="!daily.length" class="muted">暂无下载记录。</p></article>
    <article class="card"><h2>下载 TOP 20</h2><div v-for="item in top" :key="item.fileId" class="upload-status"><span class="break-word">{{ item.name || '已删除文件' }}</span><span>{{ item.downloads }} 次 · {{ item.bytes }} B</span></div><p v-if="!top.length" class="muted">暂无排名。</p></article>
    <article class="card"><h2>分享访问来源</h2><p class="muted">仅汇总通过策略检查的文件分享访问；不记录来源 URL 路径或参数。</p><div v-for="(item, index) in access" :key="index" class="upload-status"><span class="break-word">{{ item.refererHost || '直接访问 / 未提供来源' }}</span><span>{{ item.day }} · {{ item.accessCount }} 次</span></div><p v-if="!access.length" class="muted">暂无访问来源。</p></article>
    <article class="card"><h2>IP 活动台账</h2><p class="muted">全站累计下载尝试与限流次数，与项目成功流量汇总分开统计。</p><article v-for="item in ips" :key="item.ip" class="notice-item"><strong>{{ item.ip }}</strong><p>{{ item.downloadCount }} 次下载尝试 · {{ item.rateLimitCount }} 次限流</p><p class="muted">最近活动 {{ item.lastAccessAt }}</p></article><p v-if="!ips.length" class="muted">暂无 IP 活动。</p></article>
    <article class="card"><h2>下载明细</h2><div class="module-form file-toolbar"><select v-model="source" aria-label="下载来源筛选" @change="filter"><option value="">全部来源</option><option v-for="value in ['ADMIN', 'OPEN_API', 'PUBLIC', 'SHARE', 'FOLDER_SHARE', 'WEBDAV', 'BATCH']" :key="value">{{ value }}</option></select><select v-model="successful" aria-label="下载结果筛选" @change="filter"><option value="">全部结果</option><option value="true">成功输出</option><option value="false">失败或云端未确认</option></select></div>
      <article v-for="item in records" :key="item.id" class="notice-item"><div class="card-head"><strong>{{ item.ip }}</strong><span class="badge">{{ item.source }}</span></div><p>{{ item.createdAt }} · {{ item.bytesSent }} B · {{ item.success ? '成功输出' : '失败或未确认' }}</p><p v-if="item.failureReason" class="muted break-word">{{ item.failureReason }}</p></article><p v-if="!records.length" class="muted">没有匹配的下载明细。</p><div class="resource-actions"><n-button :disabled="page === 0" @click="paginate(-1)">上一页</n-button><span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(total / 50)) }}</span><n-button :disabled="(page + 1) * 50 >= total" @click="paginate(1)">下一页</n-button></div>
    </article>
    <article class="card"><h2>已封禁 IP</h2><div v-for="ban in bans" :key="ban.ip" class="upload-status"><span>{{ ban.ip }} · {{ ban.reason }}</span><n-button @click="unban(ban.ip)">解除封禁</n-button></div><p v-if="!bans.length" class="muted">暂无封禁记录。</p></article>
  </section>
</template>
