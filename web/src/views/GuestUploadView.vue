<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { NAlert, NButton, NInput, NProgress } from 'naive-ui'
import { useThemeStore } from '@/stores/theme'
const theme = useThemeStore()
const token = ref('')
const selected = ref<File[]>([])
const results = ref<{ name: string; state: string; progress: number }[]>([])
const busy = ref(false)
const error = ref('')
let disposed = false
let active: XMLHttpRequest | undefined
function choose(files: FileList | null) { selected.value = files ? Array.from(files).slice(0, 100) : []; error.value = '' }
function transfer(file: File, result: { name: string; state: string; progress: number }) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest(); active = request
    request.open('POST', '/api/public/uploads/credential')
    request.setRequestHeader('X-Upload-Token', token.value.trim())
    request.upload.onprogress = event => { if (event.lengthComputable) result.progress = Math.min(99, Math.round(event.loaded / event.total * 100)) }
    request.onerror = () => reject(new Error('网络异常，请检查后重试'))
    request.onabort = () => reject(new Error('上传已停止'))
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) { result.progress = 100; result.state = '已完成'; resolve(); return }
      let message = `上传失败 (${request.status})`
      try { message = JSON.parse(request.responseText).error?.message ?? message } catch { /* Keep the safe fallback for non-JSON upstream errors. */ }
      if ([401, 403].includes(request.status)) token.value = ''
      reject(new Error(message))
    }
    const body = new FormData(); body.append('file', file); request.send(body)
  })
}
async function submit() {
  if (busy.value || !token.value.trim() || !selected.value.length) return
  busy.value = true; error.value = ''; results.value = selected.value.map(file => ({ name: file.name, state: '等待中', progress: 0 }))
  try {
    for (let i = 0; i < selected.value.length; i++) {
      if (disposed) return
      const result = results.value[i]!; result.state = '上传中'
      try { await transfer(selected.value[i]!, result) } catch (e) { result.state = '失败'; throw e }
    }
  } catch (e) { error.value = e instanceof Error ? e.message : '上传失败' }
  finally { active = undefined; busy.value = false }
}
onUnmounted(() => { disposed = true; active?.abort(); token.value = ''; selected.value = [] })
</script>
<template>
  <main class="public-page">
    <header class="public-header"><strong>统一文件管理</strong><n-button @click="theme.toggle()">{{ theme.isDark ? '切换浅色' : '切换深色' }}</n-button></header>
    <section class="public-hero"><div class="eyebrow">A SECURE DROP-OFF</div><h1>提交你的文件</h1><p>使用管理员提供的上传凭证，安全提交到指定空间。无需管理员账号。</p></section>
    <section class="card public-card module-form">
      <p class="muted">凭证仅保存在本页内存，不加入链接，不存入浏览器。范围、类型、数量、大小及到期时间由服务器验证。每次最多选择 100 个文件，按顺序提交。</p>
      <n-alert v-if="error" type="error" role="alert">{{ error }}</n-alert>
      <label>上传凭证<n-input v-model:value="token" type="password" :disabled="busy" :input-props="{ 'aria-label': '上传凭证', autocomplete: 'off', maxlength: 128 }" /></label>
      <label class="upload-control">选择文件<input type="file" multiple aria-label="选择待上传文件" :disabled="busy" @change="choose(($event.target as HTMLInputElement).files)" /></label>
      <n-button type="primary" :disabled="!token.trim() || !selected.length" :loading="busy" @click="submit">提交文件</n-button>
      <div v-for="(result, index) in results" :key="index" class="upload-item"><strong class="break-word">{{ result.name }} · {{ result.state }}</strong><n-progress type="line" :percentage="result.progress" /></div>
    </section>
    <footer>文件仅向管理员提交。本页不列出或读取目标空间已有文件。</footer>
  </main>
</template>
