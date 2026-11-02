<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import { http } from '@/api/http'
interface Status {
  version: string; database: string; time: string
  queue?: { pending: number; running: number; failed: number; paused: number; expiredLeases: number }
  storages: { id: string; name: string; provider: string; status: string; checkedAt?: string }[]
}
const snapshot = ref<Status | null>(null), busy = ref(false), error = ref('')
async function load() {
  busy.value = true; error.value = ''
  try { snapshot.value = await http.get<Status>('/system/status') } catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
function label(status: string) { return ({ UP: '正常', DOWN: '异常', UNKNOWN: '未检测', DISABLED: '已停用' } as Record<string, string>)[status] ?? '未检测' }
onMounted(load)
</script>
<template>
  <article class="card module-form">
    <div class="card-head"><h2>系统健康</h2><n-button :loading="busy" @click="load">刷新系统健康</n-button></div>
    <n-alert v-if="error" type="error">{{ error }}</n-alert>
    <template v-if="snapshot?.version">
      <strong>当前版本 {{ snapshot.version }}</strong><span>数据库：{{ label(snapshot.database) }}</span><p class="muted">面板读取时间 {{ snapshot.time }}。存储为 Worker 最近探测快照，并非实时状态；未检测不代表可用。</p>
      <div v-if="snapshot.queue" class="resource-actions"><span>等待 {{ snapshot.queue.pending }}</span><span>运行 {{ snapshot.queue.running }}</span><span>失败 {{ snapshot.queue.failed }}</span><span>暂停 {{ snapshot.queue.paused }}</span><span>过期租约 {{ snapshot.queue.expiredLeases }}</span></div>
      <div v-for="storage in snapshot.storages" :key="storage.id" class="notice-item"><strong class="break-word">{{ storage.name }} · {{ storage.provider }} · {{ label(storage.status) }}</strong><p class="muted">最近探测 {{ storage.checkedAt || '尚无快照' }}</p></div>
      <router-link to="/storages">管理存储并执行实时连通测试</router-link><router-link to="/tasks">查看后台任务与失败记录</router-link>
    </template>
  </article>
</template>
