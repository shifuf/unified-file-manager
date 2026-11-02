<script setup lang="ts">
import { NButton } from 'naive-ui'
import { onBeforeUnmount, ref, watch } from 'vue'
import type Hls from 'hls.js'
import PdfPreview from './PdfPreview.vue'
const props = defineProps<{ preview: { kind: string; content: string; truncated: boolean; hlsReady?: boolean }; watermark?: string; mediaUrl?: string; hlsUrl?: string }>()
defineEmits<{ close: []; office: [] }>()
const video = ref<HTMLVideoElement | null>(null)
const mode = ref('MP4')
let loader: Hls | undefined
let generation = 0
function stop() { generation++; loader?.destroy(); loader = undefined }
function fallback() {
  stop(); mode.value = 'MP4'
  if (video.value && props.mediaUrl) { video.value.src = props.mediaUrl; video.value.load() }
}
watch([video, () => props.hlsUrl, () => props.mediaUrl], async () => {
  stop(); const current = generation, element = video.value
  if (!element || !props.mediaUrl) return
  mode.value = 'MP4'; element.src = props.mediaUrl
  if (!props.preview.hlsReady || !props.hlsUrl) return
  const url = props.hlsUrl
  if (element.canPlayType('application/vnd.apple.mpegurl')) { mode.value = 'HLS'; element.src = url; return }
  try {
    const { default: Player } = await import('hls.js')
    if (current !== generation) return
    if (!Player.isSupported()) return
    mode.value = 'HLS'
    loader = new Player({ enableWorker: true, maxBufferLength: 20, backBufferLength: 10 })
    loader.on(Player.Events.ERROR, (_event, data) => { if (data.fatal) fallback() })
    loader.loadSource(url); loader.attachMedia(element)
  } catch { if (current === generation) fallback() }
}, { flush: 'post' })
onBeforeUnmount(stop)
</script>
<template><section class="preview-content"><div class="card-head"><h3>文件预览</h3><n-button size="small" @click="$emit('close')">关闭预览</n-button></div><div class="preview-surface"><pre v-if="preview.kind === 'TEXT'" class="preview-text">{{ preview.content }}</pre><img v-else-if="preview.kind === 'IMAGE' && mediaUrl" class="preview-image" :src="mediaUrl" alt="文件图片预览" /><video ref="video" v-else-if="preview.kind === 'VIDEO' && mediaUrl" class="preview-media" :src="mediaUrl" controls preload="metadata" aria-label="文件视频预览" /><audio v-else-if="preview.kind === 'AUDIO' && mediaUrl" class="preview-media" :src="mediaUrl" controls preload="metadata" aria-label="文件音频预览" /><pdf-preview v-else-if="preview.kind === 'PDF' && mediaUrl" :url="mediaUrl" /><div v-else-if="preview.kind === 'OFFICE'" class="office-preview"><p class="muted">Office 文档需要借助你配置的外部预览服务打开。点击下方按钮会先要求确认，再把该文件以一次性短期链接交给该服务。</p><n-button type="primary" @click="$emit('office')">使用外部服务预览</n-button></div><p v-else class="muted">尚无可用预览，或文件类型不支持安全预览。</p><div v-if="watermark" class="preview-watermark" aria-label="预览水印"><span v-for="n in 6" :key="n">{{ watermark }}</span></div></div><div v-if="preview.kind === 'VIDEO' && preview.hlsReady" class="resource-actions"><span class="badge">{{ mode }} 播放</span><n-button size="small" @click="fallback">使用 MP4 备选</n-button></div><p v-if="preview.truncated" class="muted">内容较长，仅展示前 262144 个字符。</p><p class="muted">仅预览限制不等同于 DRM；可见内容仍可复制或截屏。</p></section></template>
<style scoped>.preview-image { display: block; max-width: 100%; max-height: 65vh; margin: auto; object-fit: contain; }.preview-media { display: block; width: 100%; max-height: 65vh; } .preview-document { display: block; width: 100%; height: 65vh; border: 0; }</style>
