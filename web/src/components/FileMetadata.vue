<script setup lang="ts">
import { ref, watch } from 'vue'
import { http } from '@/api/http'
const props = defineProps<{ fileId: string }>()
interface Details { file: { size: number; mime: string; checksum: string; createdAt: string; version: number }; storage: { name: string; provider: string }; accessRoute: string; successfulDownloads: number; shares: { id: string; token: string; enabled: boolean; previewOnly: boolean }[] }
const details = ref<Details | null>(null), error = ref('')
watch(() => props.fileId, async id => {
  details.value = null; error.value = ''
  try { const result = await http.get<Details>(`/files/${id}/details`); if (props.fileId === id && result.file) details.value = result }
  catch (e) { if (props.fileId === id) error.value = String(e) }
}, { immediate: true })
</script>
<template><section><h3>内容与存储信息</h3><p v-if="error" role="alert">{{ error }}</p><template v-if="details"><dl class="file-metadata"><dt>大小与类型</dt><dd>{{ details.file.size }} B · {{ details.file.mime }}</dd><dt>上传时间</dt><dd>{{ details.file.createdAt }}</dd><dt>SHA256 指纹</dt><dd><code class="break-word">{{ details.file.checksum || '等待检查' }}</code></dd><dt>所在存储</dt><dd>{{ details.storage.name }} · {{ details.storage.provider }}</dd><dt>默认下载路径</dt><dd>{{ details.accessRoute === 'SERVER_STREAM' ? '服务器流式输出' : '签名跳转（非本站加速统计）' }}</dd><dt>本站确认成功下载</dt><dd>{{ details.successfulDownloads }} 次 · 当前 v{{ details.file.version }}</dd></dl><h3>引用此文件的分享</h3><p v-if="!details.shares.length" class="muted">尚无文件分享引用。</p><div v-for="share in details.shares" :key="share.id" class="upload-status"><router-link :to="`/s/${encodeURIComponent(share.token)}`">{{ share.token }}</router-link><span>{{ share.enabled ? '已启用' : '已停用' }}{{ share.previewOnly ? ' · 仅预览' : '' }}</span></div></template></section></template>
<style scoped>.file-metadata { display: grid; gap: 0.5rem; }.file-metadata dt { color: var(--text-muted); }.file-metadata dd { margin: 0 0 0.5rem; overflow-wrap: anywhere; }</style>
