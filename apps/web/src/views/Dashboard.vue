<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">系统概览</h1>
        <p class="page-subtitle">查看项目、文件和当前存储配置概况。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="$router.push('/projects')">新建项目</el-button>
    </div>

    <section class="metric-grid" aria-label="关键指标">
      <div class="metric">
        <div class="metric-label">项目总数</div>
        <div class="metric-value">{{ projects.length }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">已启用项目</div>
        <div class="metric-value">{{ enabledProjectCount }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">文件总数</div>
        <div class="metric-value">{{ totalFileCount }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">存储平台</div>
        <div class="metric-value">{{ activeProviderCount }}</div>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-title">项目列表</div>
        <el-table v-loading="loading" :data="projects" row-key="id">
          <el-table-column prop="name" label="项目名称" min-width="180" />
          <el-table-column prop="appId" label="AppID" min-width="180">
            <template #default="{ row }">
              <span class="mono">{{ row.appId }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="activeCdnName" label="当前存储" min-width="160" />
          <el-table-column prop="fileCount" label="文件数" width="100" />
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button link type="primary" @click="$router.push(`/projects/${row.id}`)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Plus } from '@element-plus/icons-vue';
import { computed, onMounted, ref } from 'vue';

import { projectApi } from '@/api/modules';
import type { Project } from '@/types';

const loading = ref(false);
const projects = ref<Project[]>([]);
const enabledProjectCount = computed(() => projects.value.filter((project) => project.enabled).length);
const totalFileCount = computed(() => projects.value.reduce((total, project) => total + project.fileCount, 0));
const activeProviderCount = computed(
  () => new Set(projects.value.map((project) => project.activeCdnProvider).filter(Boolean)).size,
);

async function loadProjects(): Promise<void> {
  loading.value = true;
  try {
    projects.value = await projectApi.list();
  } finally {
    loading.value = false;
  }
}

onMounted(loadProjects);
</script>

<style scoped>
.section-title {
  margin-bottom: 12px;
  font-weight: 700;
}
</style>
