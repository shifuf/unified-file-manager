<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">任务中心</h1>
        <p class="page-subtitle">查看批量文件操作、迁移、导入等后台任务记录。</p>
      </div>
      <div class="toolbar">
        <el-button :icon="Delete" type="danger" plain :disabled="loading || deleting" @click="cleanupTasks">清理已结束记录</el-button>
        <el-button :icon="Delete" type="danger" plain :disabled="!selectedTasks.length || loading" :loading="deleting" @click="removeSelectedTasks">批量删除{{ selectedTasks.length ? `（${selectedTasks.length}）` : '' }}</el-button>
        <el-button :icon="Refresh" :disabled="deleting" @click="reload">刷新</el-button>
      </div>
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
            @change="searchTasks"
          >
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-select v-model="filters.status" clearable placeholder="状态" style="width: 140px" @change="searchTasks">
            <el-option v-for="option in taskStatusOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
          <el-select v-model="filters.type" clearable placeholder="任务类型" style="width: 180px" @change="searchTasks"><el-option v-for="option in taskTypeOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select>
          <span class="muted">仅可勾选已完成、失败或已取消的任务，删除只清理任务记录。</span>
        </div>

        <TableViewport v-slot="{ pinActions }" label="任务列表">
        <el-table ref="taskTable" v-loading="loading || deleting" :data="pageResult.items" row-key="id" class="data-table" @selection-change="handleSelectionChange">
          <el-table-column type="selection" width="48" :selectable="canDeleteTask" />
          <el-table-column prop="title" label="任务" min-width="200" />
          <el-table-column label="项目" min-width="160">
            <template #default="{ row }">{{ row.project?.name || '-' }}</template>
          </el-table-column>
          <el-table-column prop="type" label="类型" min-width="180"><template #default="{ row }">{{ taskTypeLabel(row.type) }}</template></el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="taskTagType(row.status)">{{ taskStatusLabel(row.status) }}</el-tag>
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
          <el-table-column label="操作" :fixed="pinActions ? 'right' : false" width="170">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">详情</el-button>
              <el-button v-if="row.type === 'STORAGE_MIGRATION' && row.status === 'RUNNING'" link type="warning" @click="pauseTask(row)">暂停</el-button>
              <el-button v-if="row.type === 'STORAGE_MIGRATION' && row.status === 'PAUSED'" link type="success" @click="resumeTask(row)">继续</el-button>
              <el-button v-if="['RUNNING', 'PAUSED'].includes(row.status)" link type="danger" @click="cancelTask(row)">取消</el-button>
              <el-button v-if="canRetryTask(row)" link type="primary" @click="retryTask(row)">重试</el-button>
              <el-button v-if="canDeleteTask(row)" link type="danger" :disabled="deleting" @click="removeTask(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        </TableViewport>

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
          <span>{{ taskTypeLabel(selectedTask.type) }}</span>
        </div>
        <div class="detail-row">
          <span class="muted">状态</span>
          <el-tag :type="taskTagType(selectedTask.status)">{{ taskStatusLabel(selectedTask.status) }}</el-tag>
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
import { Delete, Refresh } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox, type TableInstance } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import TableViewport from '@/components/TableViewport.vue';

import { projectApi, taskApi } from '@/api/modules';
import type { PageResult, Project, TaskItem } from '@/types';
import { canDeleteTask, canRetryTask, taskStatusLabel, taskStatusOptions, taskTagType, taskTypeLabel, taskTypeOptions } from '@/utils/task-view';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const deleting = ref(false);
const taskTable = ref<TableInstance>();
const selectedTasks = ref<TaskItem[]>([]);
let reloadVersion = 0;
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
  ElMessage.success('重试任务已进入执行队列，请查看实际进度和结果。');
  await reload();
}

async function removeTask(task: TaskItem): Promise<void> {
  await deleteTasks([task]);
}

async function cleanupTasks(): Promise<void> {
  if (loading.value || deleting.value) return;
  try {
    await ElMessageBox.confirm('清理当前项目下全部已完成、失败或已取消的任务记录？无需选择时间，不会删除文件或正在执行的任务。', '清理任务记录', {
      type: 'warning', confirmButtonText: '确认清理', cancelButtonText: '取消',
    });
  } catch (error) {
    if (error === 'cancel' || error === 'close') return;
    throw error;
  }
  deleting.value = true;
  try {
    const result = await taskApi.cleanup({ projectId: filters.projectId || undefined });
    detailVisible.value = false;
    selectedTask.value = null;
    ElMessage.success(`已清理 ${result.deleted} 条任务记录。`);
    await reload();
  } finally {
    deleting.value = false;
  }
}

function handleSelectionChange(tasks: TaskItem[]): void {
  selectedTasks.value = tasks.filter(canDeleteTask);
}

async function removeSelectedTasks(): Promise<void> {
  await deleteTasks(selectedTasks.value.slice());
}

async function deleteTasks(tasks: TaskItem[]): Promise<void> {
  if (deleting.value || loading.value || !tasks.length || tasks.some(task => !canDeleteTask(task))) return;
  deleting.value = true;
  try {
    try {
      await ElMessageBox.confirm(`确认删除选中的 ${tasks.length} 条任务记录？不会删除对应文件，删除后记录无法恢复。`, '删除任务记录', {
        type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
      });
    } catch (error) {
      if (error === 'cancel' || error === 'close') return;
      throw error;
    }
    const result = await taskApi.batchRemove(tasks.map(task => task.id));
    if (selectedTask.value && tasks.some(task => task.id === selectedTask.value?.id)) {
      detailVisible.value = false;
      selectedTask.value = null;
    }
    ElMessage.success(`已删除 ${result.deleted} 条任务记录。`);
    await reload();
  } finally {
    deleting.value = false;
  }
}

async function searchTasks(): Promise<void> {
  pageResult.page = 1;
  await reload();
}

async function reload(): Promise<void> {
  const version = ++reloadVersion;
  const query = filters.projectId ? { projectId: filters.projectId } : {};
  void router.replace({ path: '/tasks', query });
  loading.value = true;
  selectedTasks.value = [];
  taskTable.value?.clearSelection();
  try {
    const result = await taskApi.list({
      projectId: filters.projectId,
      status: filters.status,
      type: filters.type,
      page: pageResult.page,
      pageSize: pageResult.pageSize,
    });
    if (version !== reloadVersion) return;
    pageResult.items = result.items;
    pageResult.total = result.total;
    pageResult.page = result.page;
    pageResult.pageSize = result.pageSize;
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (pageResult.page > lastPage) {
      pageResult.page = lastPage;
      await reload();
    }
  } finally {
    if (version === reloadVersion) loading.value = false;
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
