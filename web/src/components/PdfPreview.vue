<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
const props = defineProps<{ url: string }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const current = ref(1), total = ref(0), busy = ref(false), error = ref('')
let document: PDFDocumentProxy | undefined
let loading: PDFDocumentLoadingTask | undefined
let rendering: RenderTask | undefined
let generation = 0
function stop() {
  generation++; rendering?.cancel(); rendering = undefined
  if (loading) void loading.destroy().catch(() => {})
  loading = undefined; document = undefined
}
async function draw(page: number) {
  const active = document, target = canvas.value, run = generation
  if (!active || !target) return
  busy.value = true; error.value = ''
  try {
    rendering?.cancel()
    const source = await active.getPage(page)
    if (run !== generation) return
    const bounds = source.getViewport({ scale: 1 })
    // One page at a time, capped at four million pixels independently of the PDF page dimensions.
    const scale = Math.min(1.5, 1400 / bounds.width, 2000 / bounds.height, Math.sqrt(4_000_000 / (bounds.width * bounds.height)))
    const viewport = source.getViewport({ scale })
    target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height)
    const task = source.render({ canvas: target, viewport }); rendering = task
    await task.promise
    if (run === generation) { current.value = page; source.cleanup() }
  } catch (cause) { if (run === generation && (cause as Error).name !== 'RenderingCancelledException') error.value = 'PDF 页面无法安全渲染。' }
  finally { if (run === generation) busy.value = false }
}
watch(() => props.url, async url => {
  stop(); const run = generation; current.value = 1; total.value = 0; error.value = ''; busy.value = true
  try {
    const pdf = await import('pdfjs-dist')
    if (run !== generation) return
    pdf.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
    loading = pdf.getDocument({ url, withCredentials: true, isEvalSupported: false, enableXfa: false, disableAutoFetch: true, disableStream: true, useSystemFonts: true })
    const active = await loading.promise
    if (run !== generation) { await active.destroy(); return }
    document = active; total.value = active.numPages
    await nextTick(); await draw(1)
  } catch { if (run === generation) { error.value = 'PDF 预览不可用，请检查文件或访问权限。'; busy.value = false } }
}, { immediate: true })
onBeforeUnmount(stop)
</script>
<template><section class="preview-document" aria-label="PDF 文件预览"><div class="resource-actions"><n-button size="small" :disabled="busy || current <= 1 || !total" @click="draw(current - 1)">上一页 PDF</n-button><span>{{ current }} / {{ total }}</span><n-button size="small" :disabled="busy || current >= total" @click="draw(current + 1)">下一页 PDF</n-button></div><p v-if="error" role="alert">{{ error }}</p><p v-if="busy" class="muted">正在渲染 PDF...</p><canvas ref="canvas" class="preview-pdf-canvas" aria-label="PDF 页面图像" /></section></template>
<style scoped>.preview-document { min-height: 12rem; }.preview-pdf-canvas { display: block; max-width: 100%; height: auto; margin: 1rem auto; }</style>
