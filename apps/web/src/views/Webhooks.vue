<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">出站 Webhook</h1>
        <p class="page-subtitle">
          把业务事件以 HTTP 回调推到你自己的服务（JSON + 可选 HMAC）。与「系统设置 → 消息通知」不同：后者对接统一消息推送平台发站内/IM 提醒，这里是任意外部系统集成。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">新建 Webhook</el-button>
    </div>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar filters">
          <el-select v-model="projectId" clearable filterable placeholder="筛选项目（含全局）" style="width: 280px" @change="load">
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-button :icon="Refresh" @click="load">刷新</el-button>
        </div>

        <el-table v-loading="loading" :data="items" row-key="id">
          <el-table-column prop="name" label="名称" min-width="160" />
          <el-table-column prop="url" label="URL" min-width="260" show-overflow-tooltip />
          <el-table-column label="项目" width="140">
            <template #default="{ row }">{{ row.projectId ? projectName(row.projectId) : '全局' }}</template>
          </el-table-column>
          <el-table-column label="事件" min-width="220">
            <template #default="{ row }">
              <el-tag v-for="event in asEvents(row.events)" :key="event" size="small" class="event-tag">
                {{ eventLabel(event) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="240" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="testHook(row.id)">测试</el-button>
              <el-button link type="primary" @click="openDeliveries(row)">投递</el-button>
              <el-button link type="primary" @click="toggleEnabled(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
              <el-button link type="danger" @click="remove(row.id)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <el-dialog v-model="dialogVisible" title="新建 Webhook" width="560px">
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="URL">
          <el-input v-model="form.url" placeholder="https://example.com/hooks/ufm" />
        </el-form-item>
        <el-form-item label="Secret（可选）">
          <el-input v-model="form.secret" placeholder="用于 X-UFM-Signature" />
        </el-form-item>
        <el-form-item label="项目（留空=全局）">
          <el-select v-model="form.projectId" clearable filterable class="full-input">
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="事件">
          <el-select v-model="form.events" multiple filterable class="full-input">
            <el-option
              v-for="event in eventOptions"
              :key="event.value"
              :label="event.label"
              :value="event.value"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="deliveriesVisible" title="投递记录" size="480px">
      <el-table v-loading="deliveriesLoading" :data="deliveries" size="small">
        <el-table-column label="事件" min-width="140">
          <template #default="{ row }">{{ eventLabel(String(row.event || '')) }}</template>
        </el-table-column>
        <el-table-column label="结果" width="80">
          <template #default="{ row }">
            <el-tag :type="row.success ? 'success' : 'danger'" size="small">{{ row.success ? 'OK' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="statusCode" label="HTTP" width="70" />
        <el-table-column prop="error" label="错误" min-width="140" show-overflow-tooltip />
        <el-table-column label="时间" min-width="150">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';

import { projectApi } from '@/api/modules';
import { http } from '@/api/http';
import type { Project } from '@/types';

type WebhookItem = {
  id: string;
  name: string;
  url: string;
  projectId?: string | null;
  events: string[] | unknown;
  enabled: boolean;
};

const loading = ref(false);
const saving = ref(false);
const projects = ref<Project[]>([]);
const items = ref<WebhookItem[]>([]);
const projectId = ref('');
const dialogVisible = ref(false);
const deliveriesVisible = ref(false);
const deliveriesLoading = ref(false);
const deliveries = ref<Array<Record<string, unknown>>>([]);
const form = reactive({
  name: '',
  url: '',
  secret: '',
  projectId: '' as string,
  events: ['file.uploaded', 'file.infected', 'quota.exceeded'] as string[],
});

const eventOptions = [
  { value: '*', label: '全部事件' },
  { value: 'file.uploaded', label: '文件上传' },
  { value: 'file.deleted', label: '文件删除' },
  { value: 'file.restored', label: '文件恢复' },
  { value: 'file.purged', label: '文件彻底删除' },
  { value: 'file.updated', label: '文件更新' },
  { value: 'file.scanned', label: '扫描完成' },
  { value: 'file.infected', label: '病毒感染' },
  { value: 'file.published', label: '发布到资源库' },
  { value: 'file.unpublished', label: '取消资源库发布' },
  { value: 'quota.exceeded', label: '配额超限' },
  { value: 'scan.error', label: '扫描失败' },
  { value: 'cdn.health.fail', label: '存储健康失败' },
];

const eventLabelMap = Object.fromEntries(eventOptions.map((item) => [item.value, item.label]));

function eventLabel(event: string): string {
  return eventLabelMap[event] || event;
}

function asEvents(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function projectName(id: string): string {
  return projects.value.find((item) => item.id === id)?.name || id;
}

function formatTime(value?: unknown): string {
  return value ? new Date(String(value)).toLocaleString() : '-';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    items.value = (await http.get('/webhooks', {
      params: projectId.value ? { projectId: projectId.value } : {},
    })) as WebhookItem[];
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  form.name = '';
  form.url = '';
  form.secret = '';
  form.projectId = projectId.value || '';
  form.events = ['file.uploaded', 'file.infected', 'quota.exceeded'];
  dialogVisible.value = true;
}

async function create(): Promise<void> {
  saving.value = true;
  try {
    await http.post('/webhooks', {
      name: form.name,
      url: form.url,
      secret: form.secret || null,
      projectId: form.projectId || null,
      events: form.events,
      enabled: true,
    });
    dialogVisible.value = false;
    ElMessage.success('Webhook 已创建。');
    await load();
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(row: WebhookItem): Promise<void> {
  await http.put(`/webhooks/${row.id}`, { enabled: !row.enabled });
  ElMessage.success(row.enabled ? '已停用。' : '已启用。');
  await load();
}

async function remove(id: string): Promise<void> {
  await ElMessageBox.confirm('删除后不可恢复。', '删除 Webhook', { type: 'warning' });
  await http.delete(`/webhooks/${id}`);
  ElMessage.success('已删除。');
  await load();
}

async function testHook(id: string): Promise<void> {
  const result = (await http.post(`/webhooks/${id}/test`)) as {
    success?: boolean;
    error?: string;
  };
  ElMessage[result?.success ? 'success' : 'error'](
    result?.success ? '测试投递成功。' : `测试失败：${result?.error || 'unknown'}`,
  );
}

async function openDeliveries(row: WebhookItem): Promise<void> {
  deliveriesVisible.value = true;
  deliveriesLoading.value = true;
  try {
    const result = (await http.get(`/webhooks/${row.id}/deliveries`, {
      params: { page: 1, pageSize: 50 },
    })) as { items?: Array<Record<string, unknown>> };
    deliveries.value = result.items || [];
  } finally {
    deliveriesLoading.value = false;
  }
}

onMounted(async () => {
  projects.value = await projectApi.list();
  await load();
});
</script>

<style scoped>
.event-tag {
  margin: 0 4px 4px 0;
}
.full-input {
  width: 100%;
}
</style>
