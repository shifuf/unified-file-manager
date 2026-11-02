<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { NAlert, NButton, NDataTable, NInput, NModal, NProgress, NTree, useDialog, useMessage, type DataTableColumns, type TreeOption } from 'naive-ui'
import { useUploadQueue } from '@/composables/useUploadQueue'
import { useElementSize, useVirtualList } from '@vueuse/core'
import { http } from '@/api/http'
import { useRoute } from 'vue-router'
import { actions as defaultActions, preference } from '@/composables/displayPreferences'
import FilePreview from '@/components/FilePreview.vue'
import FileMetadata from '@/components/FileMetadata.vue'
interface FileRow { id: string; originalName: string; size: number; mime: string; folderPath: string; isPublic?: boolean; note?: string; tags?: string[] }
interface Project { id: string; name: string }
interface Version { id: string; version: number; originalName: string; size: number }
const message = useMessage()
const dialog = useDialog()
const route = useRoute()
const projects = ref<Project[]>([])
const project = ref('')
const items = ref<FileRow[]>([])
const folders = ref<{ id: string; path: string }[]>([])
const folder = ref('/')
const query = ref('')
const category = ref('')
const tag = ref('')
const note = ref('')
const total = ref(0)
const recycle = ref(false)
const grid = ref(false)
const page = ref(0)
const busy = ref(false)
const error = ref('')
const selected = ref<(string | number)[]>([])
const editing = ref<FileRow | null>(null)
const editTags = ref('')
const copyName = ref('')
const copyFolder = ref('/')
const directUrl = ref('')
const targetStorages = ref<{ id: string; name: string }[]>([])
const targetStorage = ref('')
async function copyStorage() {
  if (!editing.value || !targetStorage.value) return
  try {
    await http.post(`/files/${editing.value.id}/copy-to-storage`, { targetStorageId: targetStorage.value })
    message.success('跨存储任务已进入队列，可在后台任务查看进度；原对象保留')
  } catch (e) { message.error(String(e)) }
}
const versions = ref<Version[]>([])
const preview = ref<{ kind: string; content: string; truncated: boolean; hlsReady?: boolean } | null>(null)
const mediaUrl = ref('')
const officeBusy = ref(false)
function openOfficePreview() {
  if (!editing.value) return
  const file = editing.value
  dialog.warning({
    title: '确认发送到外部预览服务',
    content: `《${file.originalName}》会通过一次性短期链接交给你在全局设置中配置的 Office 预览服务，该第三方可读取文件内容。只有在信任该服务时继续。`,
    positiveText: '确认发送',
    negativeText: '取消',
    onPositiveClick: async () => {
      officeBusy.value = true
      try {
        const result = await http.post<{ previewUrl: string; expiresAt: number }>(`/files/${file.id}/office-preview`, { confirmExternalTransfer: true })
        window.open(result.previewUrl, '_blank', 'noopener,noreferrer')
      } catch (e) { message.error(String(e)) } finally { officeBusy.value = false }
    }
  })
}
async function showPreview() {
  if (!editing.value) return
  try {
    const result = await http.get<{ kind: string; content: string; truncated: boolean; hlsReady?: boolean }>(`/files/${editing.value.id}/preview`)
    mediaUrl.value = ['IMAGE', 'VIDEO', 'AUDIO', 'PDF'].includes(result.kind) ? (await http.post<{ url: string }>(`/files/${editing.value.id}/preview-ticket`)).url : ''
    preview.value = result
  } catch (e) { message.error(String(e)) }
}
const share = ref<FileRow | null>(null)
const sharePassword = ref('')
const shareUrl = ref('')
const folderOpen = ref(false)
const newFolder = ref('')
const moveOpen = ref(false)
const moveFolder = ref('/')
const hoverActions = ref(defaultActions.map(value => value.id))
const uploadLimit = ref(100)
const queue = useUploadQueue(load)
const uploads = queue.jobs
const visible = computed(() => items.value)
const gridViewport = ref<HTMLElement | null>(null)
const { width: gridWidth } = useElementSize(gridViewport)
const gridColumns = computed(() => Math.max(1, Math.floor((gridWidth.value + 16) / 196)))
const gridRows = computed(() => Array.from({ length: Math.ceil(visible.value.length / gridColumns.value) }, (_, index) => visible.value.slice(index * gridColumns.value, (index + 1) * gridColumns.value)))
const { list: virtualRows, containerProps, wrapperProps } = useVirtualList(gridRows, { itemHeight: 190, overscan: 2 })
interface FolderNode { [key: string]: unknown; key: string; label: string; children: FolderNode[] }
const tree = computed(() => {
  const root: FolderNode = { key: '/', label: '全部目录', children: [] }
  const nodes = new Map<string, FolderNode>([['/', root]])
  for (const item of folders.value) {
    let parent = root, path = '/'
    for (const segment of item.path.split('/').filter(Boolean)) {
      path += `${segment}/`
      let node = nodes.get(path)
      if (!node) { node = { key: path, label: segment, children: [] }; nodes.set(path, node); parent.children.push(node) }
      parent = node
    }
  }
  return [root]
})
function treeNodeProps({ option }: { option: TreeOption }) {
  return { role: 'treeitem', 'aria-label': String(option.label), 'aria-level': String(option.key).split('/').filter(Boolean).length + 1, 'aria-selected': option.key === folder.value }
}
import { bytes } from '@/composables/format'
async function load() {
  if (!project.value) return
  busy.value = true; error.value = ''; selected.value = []
  try {
    const path = recycle.value ? '/recycle' : query.value ? '/files/search' : '/files'
    // 文件列表与目录树并行加载：目录树不再排队等列表返回，首屏更快且互不阻塞。
    const [result, folderResult] = await Promise.all([
      http.get<{ items: FileRow[]; total?: number }>(path, { query: { projectId: project.value, page: page.value, size: 100, ...(query.value ? { q: query.value } : !recycle.value ? { folderPath: folder.value, category: category.value || undefined, tag: tag.value || undefined, note: note.value || undefined } : {}) } }),
      http.get<{ items: { id: string; path: string }[] }>('/folders/tree', { query: { projectId: project.value } }),
    ])
    items.value = result.items; total.value = result.total ?? result.items.length
    folders.value = folderResult.items
  } catch (e) { error.value = String(e) } finally { busy.value = false }
}
async function upload(files: FileList | null) {
  if (!files || !project.value) return
  if (files.length > uploadLimit.value) { message.error(`单次最多选择 ${uploadLimit.value} 个文件`); return }
  queue.add(files, project.value, folder.value)
}
function selectFolder(keys: (string | number)[]) { folder.value = String(keys[0] ?? '/'); page.value = 0; void load() }
async function action(row: FileRow, operation: string) {
  try {
    if (operation === 'recycle') await http.delete(`/files/${row.id}`)
    if (operation === 'restore') await http.post(`/recycle/${row.id}/restore`)
    if (operation === 'purge' && window.confirm('永久删除不可恢复，确认继续？')) await http.delete(`/recycle/${row.id}`)
    await load()
  } catch (e) { message.error(String(e)) }
}
async function download(row: FileRow) {
  try {
    // Browser streams directly to disk. The scoped HttpOnly cookie never enters JS or URLs.
    const ticket = await http.post<{ url: string }>(`/files/${row.id}/download-ticket`)
    const link = document.createElement('a'); link.href = ticket.url; link.download = row.originalName; link.click()
  } catch (e) { message.error(String(e)) }
}
async function edit(row: FileRow) {
  preview.value = null; mediaUrl.value = ''
  targetStorage.value = ''
  try { targetStorages.value = (await http.get<{ items: typeof targetStorages.value }>('/storages')).items } catch (e) { message.error(String(e)) }
  editing.value = { ...row }
  editTags.value = (row.tags ?? []).join(', '); copyName.value = row.originalName; copyFolder.value = row.folderPath; directUrl.value = ''
  try { versions.value = (await http.get<{ items: Version[] }>('/versions', { query: { fileId: row.id } })).items } catch (e) { message.error(String(e)) }
}
async function save() {
  if (!editing.value) return
  try { await http.patch(`/files/${editing.value.id}`, { originalName: editing.value.originalName, folderPath: editing.value.folderPath, note: editing.value.note, isPublic: editing.value.isPublic, tags: [...new Set(editTags.value.split(',').map(value => value.trim()).filter(Boolean))] }); editing.value = null; await load() }
  catch (e) { message.error(String(e)) }
}
async function copyFile() {
  if (!editing.value) return
  try { await http.post(`/files/${editing.value.id}/copy`, { originalName: copyName.value, folderPath: copyFolder.value }); await load(); message.success('文件已复制') }
  catch (e) { message.error(String(e)) }
}
async function generateLink() {
  if (!editing.value) return
  try { directUrl.value = (await http.get<{ url: string }>(`/files/${editing.value.id}/direct-link`, { query: { ttl: 3600 } })).url }
  catch (e) { message.error(String(e)) }
}
async function restoreVersion(id: string) { try { await http.post(`/versions/${id}/restore`); editing.value = null; await load() } catch (e) { message.error(String(e)) } }
async function createShare() {
  try {
    const result = await http.post<{ token: string }>('/shares', { fileId: share.value?.id, ...(sharePassword.value ? { password: sharePassword.value } : {}), previewOnly: false, allowedIps: [] })
    shareUrl.value = `${location.origin}/s/${result.token}`; sharePassword.value = ''
  } catch (e) { message.error(String(e)) }
}
async function createFolder() { try { await http.post('/folders', { projectId: project.value, path: `${folder.value}${newFolder.value}/` }); folderOpen.value = false; newFolder.value = ''; await load() } catch (e) { message.error(String(e)) } }
async function batchRecycle() { try { await http.post('/files/batch-recycle', { ids: selected.value }); await load() } catch (e) { message.error(String(e)) } }
async function batchMove() {
  try { await http.post('/files/batch-move', { ids: selected.value, folderPath: moveFolder.value }); moveOpen.value = false; await load() }
  catch (e) { message.error(String(e)) }
}
async function batchRecycleAction(operation: 'restore' | 'purge') {
  if (operation === 'purge' && !window.confirm(`永久删除所选 ${selected.value.length} 项文件及其历史版本，不可恢复，确认继续？`)) return
  try { await http.post(`/recycle/batch-${operation}`, { ids: selected.value }); await load() } catch (e) { message.error(String(e)) }
}
const columns: DataTableColumns<FileRow> = [
  { type: 'selection' },
  { title: '文件名称', key: 'originalName', minWidth: 200, ellipsis: { tooltip: true } },
  { title: '大小', key: 'size', width: 100, render: row => bytes(row.size) },
  { title: '操作', key: 'actions', width: 330, render: row => h('div', { class: 'file-actions' }, recycle.value ? [
    h(NButton, { size: 'small', onClick: () => action(row, 'restore') }, { default: () => '恢复文件' }),
    h(NButton, { size: 'small', onClick: () => action(row, 'purge') }, { default: () => '永久删除' }),
  ] : hoverActions.value.map(id => h(NButton, { size: 'small', onClick: () => {
    if (id === 'download') void download(row)
    if (id === 'details') void edit(row)
    if (id === 'share') { share.value = row; shareUrl.value = '' }
    if (id === 'recycle') void action(row, 'recycle')
  } }, { default: () => defaultActions.find(value => value.id === id)?.label }))) },
]
onMounted(async () => {
  try { const limits = await http.get<{ maxUploadFiles: number }>('/settings/global'); if (Number.isInteger(limits.maxUploadFiles)) uploadLimit.value = limits.maxUploadFiles } catch (e) { error.value = String(e) }
  try { hoverActions.value = await preference('hover-actions', defaultActions) } catch (e) { error.value = String(e) }
  try { projects.value = (await http.get<{ items: Project[] }>('/projects')).items; project.value = projects.value.find(value => value.id === route.query.project)?.id ?? projects.value[0]?.id ?? ''; folder.value = typeof route.query.folder === 'string' ? route.query.folder : '/'; await load() } catch (e) { error.value = String(e) }
})
</script>

<template>
  <section class="module-page" @dragover.prevent @drop.prevent="upload($event.dataTransfer?.files ?? null)">
    <div class="module-heading"><div><div class="eyebrow">CONTENT EXPLORER</div><h1>文件空间</h1><p>一个入口，组织、检索与分发你的所有文件。</p></div><div class="resource-actions"><label class="upload-control">上传文件<input aria-label="上传文件" type="file" multiple :disabled="!project || recycle" @change="upload(($event.target as HTMLInputElement).files)" /></label><label class="upload-control">上传文件夹<input aria-label="上传文件夹" type="file" webkitdirectory multiple :disabled="!project || recycle" @change="upload(($event.target as HTMLInputElement).files)" /></label></div></div>
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <div class="file-toolbar module-form"><select v-model="project" aria-label="当前项目" @change="page = 0; load()"><option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option></select><n-input v-model:value="query" placeholder="搜索文件名与中文内容" :input-props="{ 'aria-label': '搜索文件' }" @keyup.enter="page = 0; load()" /><n-button @click="page = 0; load()">搜索</n-button><n-button @click="recycle = !recycle; page = 0; load()">{{ recycle ? '返回文件' : '回收站' }}</n-button><n-button @click="grid = !grid">{{ grid ? '列表视图' : '网格视图' }}</n-button><n-button :disabled="!project || recycle" @click="folderOpen = true">新建目录</n-button></div>
    <div class="file-toolbar module-form"><select v-model="category" aria-label="文件类型筛选"><option value="">全部类型</option><option v-for="value in ['IMAGE','VIDEO','AUDIO','DOCUMENT','CODE','ARCHIVE','OTHER']" :key="value" :value="value">{{ value }}</option></select><n-input v-model:value="tag" placeholder="标签" :input-props="{ 'aria-label': '标签筛选' }" /><n-input v-model:value="note" placeholder="备注包含" :input-props="{ 'aria-label': '备注筛选' }" /><span class="muted">内容检索优先于目录与元数据筛选</span></div>
    <div v-if="!projects.length" class="card empty-state">请先创建项目并绑定存储，再开始上传。</div>
    <div v-else class="file-workspace">
      <aside class="card file-tree"><h2>目录</h2><n-tree role="tree" aria-label="项目目录" :node-props="treeNodeProps" :data="tree" :selected-keys="[folder]" block-line default-expand-all @update:selected-keys="selectFolder" /></aside>
      <div class="card file-content"><div class="card-head"><h2>{{ recycle ? '回收站' : folder }}</h2><span class="badge">{{ visible.length }} 项 / 本页 · 共 {{ total }} 项</span></div>
        <div v-if="selected.length" class="resource-actions batch-actions"><template v-if="recycle"><n-button @click="batchRecycleAction('restore')">恢复所选 {{ selected.length }} 项</n-button><n-button @click="batchRecycleAction('purge')">彻底删除所选 {{ selected.length }} 项</n-button></template><template v-else><n-button @click="moveFolder = folder; moveOpen = true">移动所选 {{ selected.length }} 项</n-button><n-button @click="batchRecycle">回收所选 {{ selected.length }} 项</n-button></template></div>
        <div v-if="grid && !recycle" ref="gridViewport"><div v-bind="containerProps" class="virtual-grid" aria-label="文件网格"><div v-bind="wrapperProps"><div v-for="row in virtualRows" :key="row.index" class="virtual-grid-row" :style="{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }"><article v-for="item in row.data" :key="item.id" class="file-tile"><span class="badge">{{ item.mime }}</span><h3>{{ item.originalName }}</h3><p>{{ bytes(item.size) }}</p><n-button @click="edit(item)">详情</n-button><n-button @click="download(item)">下载</n-button></article></div></div></div></div>
        <n-data-table v-else virtual-scroll :max-height="520" :scroll-x="680" :columns="columns" :data="visible" :row-key="row => row.id" :loading="busy" v-model:checked-row-keys="selected" />
        <div class="resource-actions"><n-button :disabled="page === 0 || busy" @click="page--; load()">上一页</n-button><span>第 {{ page + 1 }} 页</span><n-button :disabled="items.length < 100 || busy || !!query" @click="page++; load()">下一页</n-button></div>
      </div>
    </div>
    <div v-if="uploads.length" class="card"><h2>上传队列</h2><div v-for="item in uploads" :key="item.id" class="upload-status"><div class="upload-item"><strong>{{ item.name }}</strong><span>{{ item.state }}</span><n-progress type="line" :percentage="item.progress" /><p v-if="item.error" class="muted">{{ item.error }}</p></div><div class="file-actions"><label v-if="item.needsReselect" class="upload-control">重新选择源文件<input type="file" :aria-label="`重新选择源文件 ${item.name}`" @change="queue.reselect(item, ($event.target as HTMLInputElement).files?.[0])" /></label><n-button v-if="['上传中','等待中'].includes(item.state)" @click="queue.pause(item)">暂停上传</n-button><n-button v-if="['已暂停','失败'].includes(item.state)" @click="queue.resume(item)">继续上传</n-button><n-button v-if="!['已完成','已取消'].includes(item.state)" @click="queue.cancel(item).catch(e => message.error(String(e)))">取消上传</n-button></div></div></div>
    <n-modal :show="!!editing" preset="card" title="文件详情与版本" class="module-dialog" @update:show="editing = null"><form v-if="editing" class="module-form" @submit.prevent="save"><file-metadata :file-id="editing.id" /><label>文件名<n-input v-model:value="editing.originalName" /></label><label>目录<n-input v-model:value="editing.folderPath" /></label><label>备注<n-input v-model:value="editing.note" type="textarea" /></label><label>标签（逗号分隔）<n-input v-model:value="editTags" :input-props="{ 'aria-label': '文件标签' }" /></label><label><input v-model="editing.isPublic" type="checkbox" />允许公开库展示</label><n-button attr-type="submit" type="primary">保存更改</n-button><n-button @click="showPreview">预览内容</n-button><file-preview v-if="preview" :preview="preview" :media-url="mediaUrl" :hls-url="`${mediaUrl}/hls/master.m3u8`" @office="openOfficePreview" @close="preview = null" /><h3>复制与分发</h3><label>复制文件名<n-input v-model:value="copyName" :input-props="{ 'aria-label': '复制文件名' }" /></label><label>复制目标目录<n-input v-model:value="copyFolder" :input-props="{ 'aria-label': '复制目标目录' }" /></label><n-button @click="copyFile">复制文件</n-button><n-button @click="generateLink">生成限时直链</n-button><label v-if="directUrl">文件直链<n-input :value="directUrl" readonly :input-props="{ 'aria-label': '文件直链' }" /></label><h3>跨存储分发</h3><label>目标存储<select v-model="targetStorage" aria-label="跨存储目标"><option value="">请选择目标</option><option v-for="storage in targetStorages" :key="storage.id" :value="storage.id">{{ storage.name }}</option></select></label><p class="muted">后台复制并校验后切换此文件归属，保留源对象，不切换项目上传存储。</p><n-button :disabled="!targetStorage" @click="copyStorage">复制到目标存储并切换归属</n-button><h3>历史版本</h3><div v-for="version in versions" :key="version.id" class="upload-status"><span>v{{ version.version }} · {{ bytes(version.size) }}</span><n-button @click="restoreVersion(version.id)">恢复此版本</n-button></div></form></n-modal>
    <n-modal :show="!!share" preset="card" title="分享文件" class="module-dialog" @update:show="share = null"><div class="module-form"><template v-if="!shareUrl"><p>{{ share?.originalName }}</p><label>访问密码（可选）<n-input v-model:value="sharePassword" type="password" /></label><n-button type="primary" @click="createShare">创建分享</n-button></template><template v-else><label>分享地址<n-input :value="shareUrl" readonly :input-props="{ 'aria-label': '分享地址' }" /></label><n-button type="primary" @click="share = null">完成</n-button></template></div></n-modal>
    <n-modal v-model:show="folderOpen" preset="card" title="新建目录" class="module-dialog"><form class="module-form" @submit.prevent="createFolder"><label>目录名<n-input v-model:value="newFolder" :input-props="{ required: true }" /></label><n-button attr-type="submit" type="primary">创建目录</n-button></form></n-modal>
    <n-modal v-model:show="moveOpen" preset="card" title="批量移动" class="module-dialog"><form class="module-form" @submit.prevent="batchMove"><p>将所选 {{ selected.length }} 项移动到同项目目录；名称冲突时整批保留原位置。</p><label>目标目录<n-input v-model:value="moveFolder" :input-props="{ 'aria-label': '批量目标目录', required: true }" /></label><n-button attr-type="submit" type="primary">确认移动</n-button></form></n-modal>
  </section>
</template>
