<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">项目管理</h1>
        <p class="page-subtitle">创建项目、维护项目基础信息、公开文件域名白名单并管理 AppID/AppSecret。</p>
      </div>
      <div class="toolbar">
        <input ref="importInputRef" type="file" accept="application/json,.json" class="hidden-input" @change="importProject" />
        <el-button v-if="authStore.isSuperAdmin" :icon="Upload" @click="importInputRef?.click()">导入项目</el-button>
        <el-button v-if="authStore.isSuperAdmin" type="primary" :icon="Plus" @click="openCreateDialog">
          新建项目
        </el-button>
      </div>
    </div>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar">
          <el-input
            v-model="keyword"
            clearable
            placeholder="按项目名称搜索"
            style="width: 260px"
            :prefix-icon="Search"
            @keyup.enter="loadProjects"
            @clear="loadProjects"
          />
          <el-button :icon="Refresh" @click="loadProjects">刷新</el-button>
        </div>

        <el-table v-loading="loading" :data="projects" row-key="id" class="data-table">
          <el-table-column prop="name" label="项目名称" min-width="180">
            <template #default="{ row }">
              <el-button link type="primary" @click="$router.push(`/projects/${row.id}`)">
                {{ row.name }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column prop="description" label="描述" min-width="220" show-overflow-tooltip />
          <el-table-column label="公开文件域名" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ formatDomains(row.allowedDomains) }}</template>
          </el-table-column>
          <el-table-column prop="appId" label="AppID" min-width="190">
            <template #default="{ row }">
              <span class="mono">{{ row.appId }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="activeCdnName" label="当前存储" min-width="150" />
          <el-table-column prop="fileCount" label="文件数" width="100" />
          <el-table-column label="创建时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="260">
            <template #default="{ row }">
              <div class="table-actions">
                <template v-if="row.canManage">
                  <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
                  <el-button link type="primary" @click="resetSecret(row)">重置密钥</el-button>
                  <el-button link type="danger" @click="removeProject(row)">删除</el-button>
                </template>
                <span v-else class="muted">-</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <el-dialog
      v-model="dialogVisible"
      :title="editingProject ? '编辑项目' : '新建项目'"
      width="520px"
      align-center
      destroy-on-close
      append-to-body
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-form-item label="项目名称" prop="name">
          <el-input v-model="form.name" maxlength="128" show-word-limit />
        </el-form-item>
        <el-form-item label="项目描述" prop="description">
          <el-input v-model="form.description" type="textarea" :rows="4" maxlength="512" show-word-limit />
        </el-form-item>
        <el-form-item label="公开文件允许访问域名" prop="allowedDomains">
          <el-input
            v-model="form.allowedDomains"
            type="textarea"
            :rows="3"
            placeholder="files.example.com&#10;*.example.com"
          />
          <div class="form-help">每行或逗号分隔一个来源站点域名，公开图片会校验 Origin/Referer。留空时使用系统全局白名单。</div>
        </el-form-item>
        <el-form-item label="接收系统通知">
          <el-switch v-model="form.notifyEnabled" active-text="开启" inactive-text="关闭" />
        </el-form-item>
        <el-form-item label="公开资源库">
          <el-switch v-model="form.publicLibraryEnabled" active-text="开启" inactive-text="关闭" />
        </el-form-item>
        <el-form-item v-if="form.publicLibraryEnabled" label="资源库标识 slug">
          <el-input v-model="form.publicLibrarySlug" placeholder="my-project" maxlength="64" />
          <div class="form-help">公开地址：/library/{{ form.publicLibrarySlug || 'slug' }}</div>
        </el-form-item>
        <el-form-item label="存储配额（MB，0=不限）">
          <el-input-number v-model="form.quotaMb" :min="0" :step="100" controls-position="right" />
        </el-form-item>
        <el-form-item label="文件数配额（0=不限）">
          <el-input-number v-model="form.quotaFiles" :min="0" :step="10" controls-position="right" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitProject">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="secretDialogVisible"
      title="项目密钥"
      width="560px"
      align-center
      destroy-on-close
      append-to-body
    >
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        title="AppSecret 仅展示本次，关闭后无法再次查看。"
      />
      <div class="secret-box">
        <div>
          <span class="muted">AppID</span>
          <div class="mono">{{ latestSecret.appId }}</div>
        </div>
        <div>
          <span class="muted">AppSecret</span>
          <div class="mono secret-value">{{ latestSecret.appSecret }}</div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Plus, Refresh, Search, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { projectApi } from '@/api/modules';
import { useAuthStore } from '@/stores/auth';
import type { Project } from '@/types';

const loading = ref(false);
const submitting = ref(false);
const keyword = ref('');
const projects = ref<Project[]>([]);
const dialogVisible = ref(false);
const secretDialogVisible = ref(false);
const editingProject = ref<Project | null>(null);
const formRef = ref<FormInstance>();
const authStore = useAuthStore();
const router = useRouter();
const importInputRef = ref<HTMLInputElement>();
const form = reactive({
  name: '',
  description: '',
  allowedDomains: '',
  notifyEnabled: true,
  publicLibraryEnabled: false,
  publicLibrarySlug: '',
  quotaMb: 0,
  quotaFiles: 0,
});
const latestSecret = reactive({ appId: '', appSecret: '' });
const rules: FormRules = {
  name: [
    { required: true, message: '请输入项目名称。', trigger: 'blur' },
    { min: 2, message: '项目名称至少 2 个字符。', trigger: 'blur' },
  ],
};

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatDomains(value: string[] | undefined): string {
  return value && value.length > 0 ? value.join('、') : '使用全局白名单';
}

async function loadProjects(): Promise<void> {
  loading.value = true;
  try {
    projects.value = await projectApi.list(keyword.value);
  } finally {
    loading.value = false;
  }
}

function openCreateDialog(): void {
  editingProject.value = null;
  form.name = '';
  form.description = '';
  form.allowedDomains = '';
  form.notifyEnabled = true;
  form.publicLibraryEnabled = false;
  form.publicLibrarySlug = '';
  form.quotaMb = 0;
  form.quotaFiles = 0;
  dialogVisible.value = true;
}

function openEditDialog(project: Project): void {
  editingProject.value = project;
  form.name = project.name;
  form.description = project.description || '';
  form.allowedDomains = project.allowedDomains?.join('\n') || '';
  form.notifyEnabled = project.notifyEnabled ?? true;
  form.publicLibraryEnabled = project.publicLibraryEnabled ?? false;
  form.publicLibrarySlug = project.publicLibrarySlug || '';
  form.quotaMb = project.quotaBytes ? Math.round(project.quotaBytes / 1024 / 1024) : 0;
  form.quotaFiles = project.quotaFiles || 0;
  dialogVisible.value = true;
}

async function submitProject(): Promise<void> {
  const valid = await formRef.value?.validate();
  if (!valid) {
    return;
  }

  submitting.value = true;
  try {
    const payload = {
      name: form.name,
      description: form.description,
      allowedDomains: readDomainAllowlist(form.allowedDomains),
      notifyEnabled: form.notifyEnabled,
      publicLibraryEnabled: form.publicLibraryEnabled,
      publicLibrarySlug: form.publicLibraryEnabled ? form.publicLibrarySlug.trim() || undefined : null,
      quotaBytes: form.quotaMb > 0 ? form.quotaMb * 1024 * 1024 : null,
      quotaFiles: form.quotaFiles > 0 ? form.quotaFiles : null,
    };
    if (editingProject.value) {
      await projectApi.update(editingProject.value.id, payload);
      ElMessage.success('项目已更新。');
    } else {
      const result = await projectApi.create(payload);
      latestSecret.appId = result.appId;
      latestSecret.appSecret = result.appSecret;
      secretDialogVisible.value = true;
      ElMessage.success('项目已创建。');
    }
    dialogVisible.value = false;
    await loadProjects();
  } finally {
    submitting.value = false;
  }
}

function readDomainAllowlist(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function resetSecret(project: Project): Promise<void> {
  await ElMessageBox.confirm('重置后旧 AppSecret 会立即失效，确认继续？', '重置密钥', {
    type: 'warning',
    confirmButtonText: '确认重置',
    cancelButtonText: '取消',
  });
  const result = await projectApi.resetSecret(project.id);
  latestSecret.appId = result.appId;
  latestSecret.appSecret = result.appSecret;
  secretDialogVisible.value = true;
}

async function removeProject(project: Project): Promise<void> {
  await ElMessageBox.confirm('删除项目会同时禁用该项目下的文件记录，请确认已完成备份。', '删除项目', {
    type: 'warning',
    confirmButtonText: '确认删除',
    cancelButtonText: '取消',
  });
  await projectApi.remove(project.id);
  ElMessage.success('项目已删除。');
  await loadProjects();
}

async function importProject(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';

  if (!file) {
    return;
  }

  const payload = JSON.parse(await file.text()) as Record<string, unknown>;
  const result = await projectApi.import(payload);
  latestSecret.appId = result.appId;
  latestSecret.appSecret = result.appSecret;
  secretDialogVisible.value = true;
  ElMessage.success(`项目已导入，文件记录 ${result.fileRecordsImported} 条。`);
  await loadProjects();
  void router.push(`/projects/${result.id}`);
}

onMounted(loadProjects);
</script>

<style scoped>
.data-table {
  margin-top: 14px;
}

.hidden-input {
  display: none;
}

.secret-box {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}

.secret-value {
  margin-top: 6px;
  padding: 10px;
  overflow-wrap: anywhere;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-muted);
}

.form-help {
  width: 100%;
  margin-top: 6px;
  color: #64748b;
  font-size: 13px;
  line-height: 1.5;
}
</style>
