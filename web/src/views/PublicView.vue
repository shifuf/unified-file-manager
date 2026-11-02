<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { NAlert, NButton, NInput } from 'naive-ui'
import { useThemeStore } from '@/stores/theme'
import FilePreview from '@/components/FilePreview.vue'
interface File { id: string; originalName: string; mime: string; size: number }
const route = useRoute()
const theme = useThemeStore()
const brand = ref({ title: '', subtitle: '', footer: '', poweredBy: true, logo: '', pageBackground: 'bg', cardBackground: 'surface' })
const files = ref<File[]>([])
const password = ref('')
const locked = ref(false)
const error = ref('')
const previewOnly = ref(false)
const watermark = ref('')
const query = ref('')
const currentPage = ref(0)
const total = ref(0)
const folder = ref('/')
const folders = ref<{ name: string; path: string }[]>([])
const sort = ref('name')
const preview = ref<{ kind: string; content: string; truncated: boolean; hlsReady?: boolean } | null>(null)
const mediaUrl = ref('')
const hlsUrl = ref('')
async function showPreview(file: File) {
  try {
    const response = await fetch(`${base.value}/preview${route.params.kind === 's' ? '' : `/${file.id}`}`, { credentials: 'include' })
    const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || '预览不可用')
    mediaUrl.value = `${base.value}/preview-content${route.params.kind === 's' ? '' : `/${file.id}`}`
    hlsUrl.value = `${base.value}/preview-hls${route.params.kind === 's' ? '' : `/${file.id}`}/master.m3u8`
    preview.value = result
  } catch (e) { error.value = String(e) }
}
const base = computed(() => `/${route.params.kind}/${route.params.token}`)
async function load() {
  error.value = ''
  try {
    const params = route.params.kind === 'lib' ? `?${new URLSearchParams({ q: query.value, page: String(currentPage.value), size: '50' })}` : route.params.kind === 'fs' ? `?${new URLSearchParams({ path: folder.value, page: String(currentPage.value), size: '50', sort: sort.value })}` : ''
    const response = await fetch(base.value + (route.params.kind === 'fs' ? '/browse' : '') + params, { credentials: 'include', headers: { Accept: 'application/json' } })
    if (response.status === 401 || response.status === 403) { locked.value = true; return }
    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || '此分享不可用或已过期')
    locked.value = false; files.value = data.items ?? (data.file ? [data.file] : []); total.value = data.total ?? files.value.length; previewOnly.value = !!data.previewOnly; watermark.value = data.watermark ?? ''; folders.value = data.folders ?? []
  } catch (e) { error.value = String(e) }
}
function search() { currentPage.value = 0; void load() }
function paginate(delta: number) { currentPage.value += delta; void load() }
function openFolder(path: string) { folder.value = path; currentPage.value = 0; preview.value = null; void load() }
function parentFolder() { openFolder(folder.value.replace(/[^/]+\/$/, '') || '/') }
async function unlock() {
  try {
    const response = await fetch(`${base.value}/session`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }) })
    password.value = ''; if (!response.ok) throw new Error('密码不正确或分享不可用'); await load()
  } catch (e) { error.value = String(e) }
}
function download(file: File) { return `${base.value}/download${route.params.kind === 's' ? '' : `/${file.id}`}` }
onMounted(async () => { try { const response = await fetch('/api/public/brand'); if (response.ok) brand.value = await response.json() } catch { /* Default brand remains usable when optional branding is unavailable. */ } await load() })
</script>
<template><main class="public-page" :data-page-background="brand.pageBackground"><header class="public-header"><img v-if="brand.logo" class="public-logo" :src="brand.logo" alt="分享品牌 Logo" /><router-link to="/" class="badge">UFM / FILE DELIVERY</router-link><n-button @click="theme.toggle">{{ theme.isDark ? '浅色主题' : '深色主题' }}</n-button></header><section class="public-hero"><div class="eyebrow">SHARED WITH YOU</div><h1>{{ brand.title || '文件，安全抵达。' }}</h1><p>{{ brand.subtitle || '一个简洁、私密的文件分享空间。' }}</p></section><section class="card public-card" :data-card-background="brand.cardBackground"><n-alert v-if="error" type="error">{{ error }}</n-alert><form v-if="locked" class="module-form" @submit.prevent="unlock"><h2>此分享受密码保护</h2><label>访问密码<n-input v-model:value="password" type="password" :input-props="{ 'aria-label': '访问密码', required: true }" /></label><n-button type="primary" attr-type="submit">验证密码</n-button></form><template v-else><form v-if="route.params.kind === 'lib'" class="module-form file-toolbar" @submit.prevent="search"><n-input v-model:value="query" :input-props="{ 'aria-label': '公开库内容搜索', maxlength: 512 }" placeholder="搜索公开文件名称与内容" /><n-button attr-type="submit" type="primary">搜索公开文件</n-button></form><div v-if="route.params.kind === 'fs'" class="module-form"><div class="resource-actions"><n-button :disabled="folder === '/'" @click="parentFolder">返回上级目录</n-button><span class="badge" aria-label="当前分享目录">{{ folder }}</span><label>排序<select v-model="sort" aria-label="分享文件排序" @change="currentPage = 0; load()"><option value="name">文件名称</option><option value="size">大小优先</option><option value="recent">最新上传</option></select></label></div><div class="resource-actions"><n-button v-for="child in folders" :key="child.path" :aria-label="`打开目录 ${child.name}`" @click="openFolder(child.path)">{{ child.name }}</n-button></div></div><div v-if="!files.length && !error" class="empty-state">此处暂时没有公开文件。</div><article v-for="file in files" :key="file.id" class="public-file"><div><span class="badge">{{ file.mime }}</span><h2>{{ file.originalName }}</h2><p class="muted">{{ file.size }} B</p></div><n-button @click="showPreview(file)">预览文件</n-button><a v-if="!previewOnly" class="btn btn-primary" :href="download(file)">下载文件</a><span v-else class="badge">仅预览</span></article><div v-if="route.params.kind === 'lib' || route.params.kind === 'fs'" class="resource-actions"><n-button :disabled="currentPage === 0" @click="paginate(-1)">上一页</n-button><span>{{ currentPage + 1 }} / {{ Math.max(1, Math.ceil(total / 50)) }}</span><n-button :disabled="(currentPage + 1) * 50 >= total" @click="paginate(1)">下一页</n-button></div><file-preview v-if="preview" :preview="preview" :watermark="watermark" :media-url="mediaUrl" :hls-url="hlsUrl" @close="preview = null" /><p v-if="watermark" class="muted">{{ watermark }}</p></template></section><footer>{{ brand.footer }}<span v-if="brand.poweredBy"> · Powered by UFM</span></footer></main></template>

<style scoped>
.public-page[data-page-background="bg-soft"] { background: var(--bg-soft); }
.public-card[data-card-background="surface-2"] { background: var(--surface-2); }
.public-logo { max-width: 10rem; max-height: 3rem; object-fit: contain; }
</style>
