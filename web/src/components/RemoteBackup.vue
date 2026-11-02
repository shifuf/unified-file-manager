<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NAlert, NButton, NInput, useMessage } from 'naive-ui'
import { http } from '@/api/http'
const emit = defineEmits<{ imported: [] }>()
const message = useMessage()
const config = ref({ enabled: false, endpoint: '', username: '', passwordConfigured: false, retention: 7, hourUtc: 3 })
const password = ref('')
const files = ref<{ name: string; size: number }[]>([])
const error = ref('')
const busy = ref(false)
async function save() {
  try { config.value = await http.put('/backups/remote/settings', { enabled: config.value.enabled, endpoint: config.value.endpoint, username: config.value.username, retention: config.value.retention, hourUtc: config.value.hourUtc, ...(password.value ? { password: password.value } : {}) }); password.value = ''; message.success('远端备份配置已保存') }
  catch (e) { error.value = String(e) }
}
async function test() { busy.value = true; try { await http.post('/backups/remote/test', undefined, { timeout: 120_000 }); message.success('远端读写校验通过') } catch (e) { error.value = String(e) } finally { busy.value = false } }
async function list() { busy.value = true; try { files.value = (await http.get<{ items: typeof files.value }>('/backups/remote/files')).items } catch (e) { error.value = String(e) } finally { busy.value = false } }
async function importBackup(name: string) { busy.value = true; try { await http.post('/backups/remote/import', { name }, { timeout: 600_000 }); emit('imported'); message.success('远端备份已导入并验证；在本地备份卡片确认恢复') } catch (e) { error.value = String(e) } finally { busy.value = false } }
onMounted(async () => { try { const result = await http.get<typeof config.value>('/backups/remote/settings'); if (typeof result.enabled === 'boolean') config.value = result } catch (e) { error.value = String(e) } })
</script>
<template><article class="card"><h2>远端 WebDAV 备份</h2><p class="muted">每天自动全量备份；手动备份同步上传。仅清理本系统命名的归档，不删除其他远端文件。远端目录需预先创建。</p><n-alert v-if="error" type="error">{{ error }}</n-alert><form class="module-form" @submit.prevent="save"><label><input v-model="config.enabled" type="checkbox" />启用远端备份与每日计划</label><label>远端 WebDAV 目录 URL<n-input v-model:value="config.endpoint" placeholder="https://backup.example/dav/（以 / 结尾）" :input-props="{ 'aria-label': '远端 WebDAV 目录 URL', required: true }" /></label><label>远端 WebDAV 用户名<n-input v-model:value="config.username" :input-props="{ 'aria-label': '远端 WebDAV 用户名', required: true, autocomplete: 'off' }" /></label><label>远端 WebDAV 密码<n-input v-model:value="password" type="password" :placeholder="config.passwordConfigured ? '留空保留已有密码' : '仅写入，不回传'" :input-props="{ 'aria-label': '远端 WebDAV 密码', autocomplete: 'new-password' }" /></label><label>远端保留份数<input v-model.number="config.retention" type="number" min="1" max="1000" aria-label="远端保留份数" required /></label><label>每日备份 UTC 小时<input v-model.number="config.hourUtc" type="number" min="0" max="23" aria-label="每日备份 UTC 小时" required /></label><n-button attr-type="submit" type="primary">保存远端备份配置</n-button></form><div class="resource-actions"><n-button :disabled="!config.enabled || busy" @click="test">测试远端备份</n-button><n-button :disabled="!config.enabled || busy" @click="list">刷新远端备份列表</n-button></div><article v-for="file in files" :key="file.name" class="notice-item break-word"><strong>{{ file.name }}</strong><p>{{ file.size < 0 ? '未知大小' : `${file.size} B` }}</p><n-button :disabled="busy" @click="importBackup(file.name)">导入并校验远端备份</n-button></article></article></template>
