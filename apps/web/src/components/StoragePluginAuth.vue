<template>
  <div class="drive-auth">
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="account" class="account-line">
      <strong>{{ account.name }}</strong>
      <el-tag :type="account.connected ? 'success' : 'warning'">{{ account.connected ? '已连接' : '需要重新登录' }}</el-tag>
    </div>
    <div class="account-actions">
      <el-button :loading="busy" @click="start">{{ values.accountId ? '重新扫码登录' : '扫码连接阿里云盘' }}</el-button>
      <el-button v-if="values.accountId && !locked" :disabled="busy" @click="disconnect">解除绑定</el-button>
    </div>
    <p v-if="locked" class="auth-help">重新登录请使用原网盘账号。已有配置绑定的账号和云盘不可更换。</p>
    <el-form-item v-if="account && !session" label="云盘" required>
      <el-select :model-value="String(values.driveId || '')" :disabled="locked" placeholder="请选择云盘" @update:model-value="selectDrive">
        <el-option v-for="drive in account.drives" :key="drive.id" :label="drive.name" :value="drive.id" />
      </el-select>
    </el-form-item>
    <div v-if="session" class="qr-panel">
      <img v-if="qrImage" :src="qrImage" alt="阿里云盘登录二维码" width="220" height="220" />
      <div>{{ statusText }}</div>
      <div class="auth-help">使用阿里云盘 App 扫码，并在手机上确认登录。</div>
      <el-button text @click="cancel">取消扫码</el-button>
    </div>
    <div v-if="expired" class="auth-help">二维码已过期，请重新获取。</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { storagePluginsApi, type PluginAccount, type PluginLoginSession } from '@/api/storage-plugins';
import type { PluginConfigValue } from '@/utils/storage-plugin-form';

const props = defineProps<{ provider: string; values: Record<string, PluginConfigValue>; locked: boolean }>();
const emit = defineEmits<{ update: [values: Record<string, PluginConfigValue>] }>();
const busy = ref(false), error = ref(''), expired = ref(false), qrImage = ref('');
const account = ref<PluginAccount | null>(null), session = ref<PluginLoginSession | null>(null);
const scanned = ref(false);
const statusText = computed(() => scanned.value ? '已扫码，请在手机上确认' : '等待扫码');
let generation = 0;
let timer: number | undefined;
function stopTimer() { if (timer !== undefined) window.clearTimeout(timer); timer = undefined; }
async function cancel() {
  generation++; stopTimer(); busy.value = false;
  const previous = session.value; session.value = null; qrImage.value = '';
  if (previous) await storagePluginsApi.cancelLogin(props.provider, previous.sessionId).catch(() => undefined);
}
async function start() {
  await cancel();
  const token = ++generation, provider = props.provider;
  busy.value = true; error.value = ''; expired.value = false; scanned.value = false;
  try {
    const created = await storagePluginsApi.startLogin(provider, String(props.values.accountId || '') || undefined);
    if (token !== generation) { await storagePluginsApi.cancelLogin(provider, created.sessionId).catch(() => undefined); return; }
    session.value = created;
    const image = await QRCode.toDataURL(created.qrCode, { width: 220, margin: 2 });
    if (token !== generation) return;
    qrImage.value = image;
    timer = window.setTimeout(() => void poll(token, provider, created), 1500);
  } catch { if (token === generation) error.value = '获取登录二维码失败，请检查网络后重试。'; }
  finally { if (token === generation) busy.value = false; }
}
async function poll(token: number, provider: string, created: PluginLoginSession) {
  if (token !== generation) return;
  if (Date.now() >= Date.parse(created.expiresAt)) { await cancel(); expired.value = true; return; }
  try {
    const result = await storagePluginsApi.pollLogin(provider, created.sessionId);
    if (token !== generation) return;
    if (result.status === 'CONFIRMED' && result.account) {
      account.value = result.account;
      const currentDrive = String(props.values.driveId || '');
      emit('update', { ...props.values, accountId: result.account.accountId,
        driveId: result.account.drives.some(d => d.id === currentDrive) ? currentDrive : result.account.drives[0]?.id || '' });
      await cancel();
      return;
    }
    if (result.status === 'EXPIRED') { await cancel(); expired.value = true; return; }
    scanned.value = result.status === 'SCANNED';
    timer = window.setTimeout(() => void poll(token, provider, created), 2500);
  } catch {
    if (token !== generation) return;
    await cancel();
    error.value = '扫码登录未完成。请重试；重新登录时请使用原账号。';
  }
}
function selectDrive(value: string) { emit('update', { ...props.values, driveId: value }); }
async function disconnect() {
  await cancel(); busy.value = true; error.value = '';
  try {
    await storagePluginsApi.disconnectAccount(props.provider, String(props.values.accountId));
    account.value = null; emit('update', { ...props.values, accountId: '', driveId: '' });
  } catch { error.value = '账号仍被存储配置引用，无法解除绑定。'; }
  finally { busy.value = false; }
}
watch(() => [props.provider, props.values.accountId], async () => {
  const token = generation, id = String(props.values.accountId || '');
  if (id && account.value?.accountId === id) return;
  account.value = null;
  if (!id) return;
  try {
    const current = await storagePluginsApi.accountStatus(props.provider, id);
    if (token === generation && id === props.values.accountId) account.value = current;
  } catch { if (token === generation) error.value = '无法查询账号状态，请重新登录。'; }
}, { immediate: true });
onBeforeUnmount(() => { void cancel(); });
</script>

<style scoped>
.drive-auth { margin: 12px 0; padding: 16px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.account-line, .account-actions { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.qr-panel { display: flex; align-items: center; flex-direction: column; gap: 8px; margin-top: 12px; }
.auth-help { font-size: 12px; color: var(--el-text-color-secondary); margin: 8px 0; }
</style>
