<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, useMessage } from 'naive-ui'
import { http } from '@/api/http'
import { actions, cards, preference } from '@/composables/displayPreferences'
const message = useMessage()
const error = ref('')
const loading = ref(true)
const sections = ref([
  { kind: 'workbench' as const, title: '工作台卡片', item: '卡片', save: '保存工作台布局', options: cards.map(value => ({ ...value, enabled: true })) },
  { kind: 'hover-actions' as const, title: '文件悬停操作', item: '操作', save: '保存悬停操作', options: actions.map(value => ({ ...value, enabled: true })) },
])
function move(options: typeof sections.value[number]['options'], index: number, delta: number) {
  const next = index + delta
  if (next < 0 || next >= options.length) return
  const [entry] = options.splice(index, 1); options.splice(next, 0, entry!)
}
async function save(section: typeof sections.value[number]) {
  try { await http.put(`/settings/${section.kind}`, { items: section.options.filter(value => value.enabled).map(value => value.id) }); message.success('显示偏好已保存') }
  catch (e) { message.error(String(e)) }
}
onMounted(async () => {
  try { await Promise.all(sections.value.map(async section => {
    const selected = await preference(section.kind, section.options)
    const order = [...selected, ...section.options.map(value => value.id).filter(id => !selected.includes(id))]
    section.options = order.map(id => ({ ...section.options.find(value => value.id === id)!, enabled: selected.includes(id) }))
  })) } catch (e) { error.value = String(e) } finally { loading.value = false }
})
</script>
<template>
  <n-alert v-if="error" type="error">{{ error }}</n-alert>
  <div class="resource-grid"><article v-for="section in sections" :key="section.kind" class="card"><h2>{{ section.title }}</h2><p class="muted">勾选显示项目，调整顺序后保存；所有设备共用管理员偏好。</p><div v-for="(option, index) in section.options" :key="option.id" class="preference-row"><label><input v-model="option.enabled" type="checkbox" :disabled="loading" :aria-label="`显示${section.item} ${option.label}`" />{{ option.label }}</label><div class="file-actions"><n-button size="small" :disabled="loading || index === 0" :aria-label="`上移${section.item} ${option.label}`" @click="move(section.options, index, -1)">上移</n-button><n-button size="small" :disabled="loading || index === section.options.length - 1" :aria-label="`下移${section.item} ${option.label}`" @click="move(section.options, index, 1)">下移</n-button></div></div><div class="resource-actions"><n-button type="primary" :disabled="loading" @click="save(section)">{{ section.save }}</n-button></div></article></div>
</template>
