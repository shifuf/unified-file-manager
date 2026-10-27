<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">任务中心</h1>
        <p class="page-subtitle">查看批量文件操作、迁移、导入等后台任务记录。</p>
      </div>
      <el-button :icon="Refresh" @click="reload">刷新</el-button>
    </div>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar">
          <el-select
            v-model="filters.projectId"
            filterable
            clearable
            placeholder="项目"
            style="width: 260px"
            @change="reload"
          >
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-select v-model="filters.status" clearable placeholder="状态" style="width: 140px" @change="reload">
            <el-option label="完成" value="COMPLETED" />
            <el-option label="失败" value="FAILED" />
            <el-option label="运行中" value="RUNNING" />
            <el-option label="已暂停" value="PAUSED" />
          </el-select>
          <el-input v-model="filters.type" clearable placeholder="任务类型" style="width: 180px" @keyup.enter="reload" />
        </div>

        <el-table v-loading="loading" :data="pageResult.items" row-key="id" class="data-table">
          <el-table-column prop="title" label="任务" min-width="200" />
          <el-table-column label="项目" min-width="160">
            <template #default="{ row }">{{ row.project?.name || '-' }}</template>
          </el-table-column>
          <el-table-column prop="type" label="类型" min-width="180" />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="taskTagType(row.status)">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="进度" width="150">
            <template #default="{ row }">
              <el-progress :percentage="row.progress" :status="row.status === 'FAILED' ? 'exception' : undefined" />
            </template>
          </el-table-column>
          <el-table-column prop="error" label="错误" min-width="220" show-overflow-tooltip />
          <el-table-column label="创建时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="170">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">详情</el-button>
              <el-button v-if="row.type === 'STORAGE_MIGRATION' && row.status === 'RUNNING'" link type="warning" @click="pauseTask(row)">暂停</el-button>
              <el-button v-if="row.type === 'STORAGE_MIGRATION' && row.status === 'PAUSED'" link type="success" @click="resumeTask(row)">继续</el-button>
              <el-button v-if="['RUNNING', 'PAUSED'].includes(row.status)" link type="danger" @click="cancelTask(row)">取消</el-button>
              <el-button v-if="row.status === 'FAILED'" link type="primary" @click="retryTask(row)">重试</el-button>
              <el-button v-if="!['RUNNING', 'PAUSED'].includes(row.status)" link type="danger" @click="removeTask(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pagination-row">
          <el-pagination
            v-model:current-page="pageResult.page"
            v-model:page-size="pageResult.pageSize"
            :page-sizes="[10, 20, 50, 100]"
            layout="total, sizes, prev, pager, next"
            :total="pageResult.total"
            @change="reload"
          />
        </div>
      </div>
    </section>

    <el-drawer v-model="detailVisible" title="任务详情" size="560px">
      <div v-if="selectedTask" class="task-detail">
        <div class="detail-row">
          <span class="muted">任务</span>
          <span>{{ selectedTask.title }}</span>
        </div>
        <div class="detail-row">
          <span class="muted">项目</span>
          <span>{{ selectedTask.project?.name || '-' }}</span>
        </div>
        <div class="detail-row">
          <span class="muted">类型</span>
          <span class="mono">{{ selectedTask.type }}</span>
        </div>
        <div class="detail-row">
          <span class="muted">状态</span>
          <el-tag :type="taskTagType(selectedTask.status)">{{ selectedTask.status }}</el-tag>
        </div>
        <div class="detail-row">
          <span class="muted">错误</span>
          <span>{{ selectedTask.error || '-' }}</span>
        </div>
        <div class="detail-grid">
          <div>
            <div class="section-title">详情</div>
            <pre class="detail-json">{{ formatJson(selectedTask.detail || {}) }}</pre>
          </div>
          <div>
            <div class="section-title">结果</div>
            <pre class="detail-json">{{ formatJson(selectedTask.result || {}) }}</pre>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { projectApi, taskApi } from '@/api/modules';
import type { PageResult, Project, TaskItem } from '@/types';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const detailVisible = ref(false);
const selectedTask = ref<TaskItem | null>(null);
const projects = ref<Project[]>([]);
const filters = reactive({
  projectId: String(route.query.projectId || ''),
  status: '',
  type: '',
});
const pageResult = reactive<PageResult<TaskItem>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function taskTagType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'COMPLETED') {
    return 'success';
  }
  if (status === 'FAILED') {
    return 'danger';
  }
  if (status === 'RUNNING') {
    return 'warning';
  }
  return 'info';
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function openDetail(task: TaskItem): Promise<void> {
  selectedTask.value = await taskApi.get(task.id);
  detailVisible.value = true;
}

async function cancelTask(task: TaskItem): Promise<void> {
  await ElMessageBox.confirm('取消只会标记任务状态，不会撤销已经完成的外部副作用。', '取消任务', {
    type: 'warning',
    confirmButtonText: '取消任务',
    cancelButtonText: '返回',
  });
  await taskApi.cancel(task.id);
  ElMessage.success('任务已取消。');
  await reload();
}

async function pauseTask(task: TaskItem): Promise<void> {
  await taskApi.pause(task.id);
  ElMessage.success('迁移任务已暂停。');
  await reload();
}

async function resumeTask(task: TaskItem): Promise<void> {
  await taskApi.resume(task.id);
  ElMessage.success('迁移任务已恢复。');
  await reload();
}

async function retryTask(task: TaskItem): Promise<void> {
  await taskApi.retry(task.id);
  ElMessage.success('任务已登记重试。');
  await reload();
}

async function removeTask(task: TaskItem): Promise<void> {
  await ElMessageBox.confirm('删除后任务记录无法恢复。', '删除任务', {
    type: 'warning',
    confirmButtonText: '删除',
    cancelButtonText: '取消',
  });
  await taskApi.remove(task.id);
  ElMessage.success('任务已删除。');
  await reload();
}

async function reload(): Promise<void> {
  const query = filters.projectId ? { projectId: filters.projectId } : {};
  void router.replace({ path: '/tasks', query });
  loading.value = true;
  try {
    const result = await taskApi.list({
      projectId: filters.projectId,
      status: filters.status,
      type: filters.type,
      page: pageResult.page,
      pageSize: pageResult.pageSize,
    });
    pageResult.items = result.items;
    pageResult.total = result.total;
    pageResult.page = result.page;
    pageResult.pageSize = result.pageSize;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  projects.value = await projectApi.list();
  await reload();
});
</script>

<style scoped>
.data-table {
  margin-top: 14px;
}

.pagination-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.task-detail {
  display: grid;
  gap: 12px;
}

.detail-row {
  display: grid;
  gap: 5px;
}

.detail-grid {
  display: grid;
  gap: 14px;
}

.section-title {
  margin-bottom: 6px;
  font-weight: 700;
}

.detail-json {
  min-height: 150px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  font-family: "Fira Code", "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}
</style>
