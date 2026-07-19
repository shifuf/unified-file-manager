<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">IP 防刷管理</h1>
        <p class="page-subtitle">
          查看分享下载 IP 的下载次数、限流次数，并支持永久拉黑或按分钟临时拉黑。
        </p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="loadRows">刷新</el-button>
    </div>

    <section class="surface">
      <div class="surface-body toolbar">
        <el-input
          v-model="keyword"
          clearable
          placeholder="搜索 IP / 原因 / 文件名"
          class="search-input"
          @keyup.enter="reloadFirstPage"
        />
        <el-checkbox v-model="bannedOnly" @change="reloadFirstPage">仅看已拉黑</el-checkbox>
        <el-button type="primary" @click="reloadFirstPage">查询</el-button>
        <el-button @click="openBanDialog()">手动拉黑 IP</el-button>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <el-table v-loading="loading" :data="rows" row-key="id" size="small" empty-text="暂无 IP 记录">
          <el-table-column prop="ip" label="IP" min-width="140" />
          <el-table-column prop="downloadCount" label="下载次数" width="100" />
          <el-table-column prop="rateLimitCount" label="限流次数" width="100" />
          <el-table-column label="状态" width="140">
            <template #default="{ row }">
              <el-tag v-if="row.banStatus === 'permanent'" type="danger">永久拉黑</el-tag>
              <el-tag v-else-if="row.banStatus === 'temporary'" type="warning">
                临时 {{ row.banRemainingMinutes || '?' }} 分钟
              </el-tag>
              <el-tag v-else type="success">正常</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="lastFileName" label="最近文件" min-width="160" show-overflow-tooltip />
          <el-table-column prop="banReason" label="拉黑原因" min-width="160" show-overflow-tooltip />
          <el-table-column label="最近下载" min-width="160">
            <template #default="{ row }">{{ formatTime(row.lastDownloadAt) }}</template>
          </el-table-column>
          <el-table-column label="最近限流" min-width="160">
            <template #default="{ row }">{{ formatTime(row.lastRateLimitedAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="220" fixed="right">
            <template #default="{ row }">
              <el-button link type="warning" @click="openBanDialog(row)">拉黑</el-button>
              <el-button v-if="row.banned" link type="primary" @click="unban(row.ip)">解除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pager">
          <el-pagination
            background
            layout="total, prev, pager, next"
            :total="total"
            :page-size="pageSize"
            :current-page="page"
            @current-change="onPageChange"
          />
        </div>
      </div>
    </section>

    <el-dialog v-model="banDialogVisible" :title="banForm.ip ? `拉黑 ${banForm.ip}` : '手动拉黑 IP'" width="480px">
      <el-form label-position="top">
        <el-form-item label="IP 地址">
          <el-input v-model="banForm.ip" placeholder="例如 1.2.3.4" />
        </el-form-item>
        <el-form-item label="拉黑方式">
          <el-radio-group v-model="banForm.mode">
            <el-radio-button label="temporary">按分钟</el-radio-button>
            <el-radio-button label="permanent">永久</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="banForm.mode === 'temporary'" label="拉黑时长（分钟）">
          <el-input-number v-model="banForm.minutes" :min="1" :max="525600" />
        </el-form-item>
        <el-form-item label="原因（可选）">
          <el-input v-model="banForm.reason" type="textarea" :rows="2" maxlength="512" show-word-limit />
        </el-form-item>
        <el-form-item label="备注（可选）">
          <el-input v-model="banForm.notes" type="textarea" :rows="2" maxlength="512" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="banDialogVisible = false">取消</el-button>
        <el-button type="danger" :loading="banSaving" @click="submitBan">确认拉黑</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';

import { shareIpAbuseApi, type ShareIpStatRow } from '@/api/modules';

const loading = ref(false);
const banSaving = ref(false);
const rows = ref<ShareIpStatRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const keyword = ref('');
const bannedOnly = ref(false);
const banDialogVisible = ref(false);
const banForm = reactive({
  ip: '',
  mode: 'temporary' as 'temporary' | 'permanent',
  minutes: 60,
  reason: '',
  notes: '',
});

function formatTime(value?: string | null): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

async function loadRows(): Promise<void> {
  loading.value = true;
  try {
    const result = await shareIpAbuseApi.list({
      page: page.value,
      pageSize,
      keyword: keyword.value || undefined,
      bannedOnly: bannedOnly.value || undefined,
    });
    rows.value = result.items || [];
    total.value = result.total || 0;
  } finally {
    loading.value = false;
  }
}

function reloadFirstPage(): void {
  page.value = 1;
  void loadRows();
}

function onPageChange(next: number): void {
  page.value = next;
  void loadRows();
}

function openBanDialog(row?: ShareIpStatRow): void {
  banForm.ip = row?.ip || '';
  banForm.mode = 'temporary';
  banForm.minutes = 60;
  banForm.reason = row?.banReason || '';
  banForm.notes = row?.notes || '';
  banDialogVisible.value = true;
}

async function submitBan(): Promise<void> {
  const ip = banForm.ip.trim();
  if (!ip) {
    ElMessage.warning('请填写 IP。');
    return;
  }
  banSaving.value = true;
  try {
    await shareIpAbuseApi.ban({
      ip,
      permanent: banForm.mode === 'permanent',
      minutes: banForm.mode === 'temporary' ? banForm.minutes : undefined,
      reason: banForm.reason || undefined,
      notes: banForm.notes || undefined,
    });
    ElMessage.success(banForm.mode === 'permanent' ? '已永久拉黑。' : `已拉黑 ${banForm.minutes} 分钟。`);
    banDialogVisible.value = false;
    await loadRows();
  } finally {
    banSaving.value = false;
  }
}

async function unban(ip: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认解除 IP ${ip} 的拉黑？`, '解除拉黑', { type: 'warning' });
  } catch {
    return;
  }
  await shareIpAbuseApi.unban(ip);
  ElMessage.success('已解除拉黑。');
  await loadRows();
}

onMounted(() => {
  void loadRows();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.search-input {
  width: min(320px, 100%);
}

.pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
