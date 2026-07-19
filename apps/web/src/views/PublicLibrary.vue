<template>
  <main class="library-page">
    <header class="library-hero">
      <div>
        <p class="eyebrow">公开资源库</p>
        <h1>{{ library?.name || slug }}</h1>
        <p class="muted">{{ library?.description || '浏览该项目公开发布的文件资源。' }}</p>
      </div>
      <el-button @click="$router.push('/')">返回首页</el-button>
    </header>

    <section class="library-toolbar">
      <el-input
        v-model="keyword"
        clearable
        placeholder="搜索文件名、标签、备注"
        style="max-width: 280px"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-select v-model="category" clearable placeholder="类型" style="width: 140px" @change="reload">
        <el-option label="图片" value="IMAGE" />
        <el-option label="文档" value="DOCUMENT" />
        <el-option label="视频" value="VIDEO" />
        <el-option label="音频" value="AUDIO" />
        <el-option label="压缩包" value="ARCHIVE" />
        <el-option label="代码" value="CODE" />
        <el-option label="其他" value="OTHER" />
      </el-select>
      <el-select v-model="sort" style="width: 140px" @change="reload">
        <el-option label="最新" value="newest" />
        <el-option label="最旧" value="oldest" />
        <el-option label="名称" value="name" />
        <el-option label="大小" value="size" />
      </el-select>
      <el-button type="primary" @click="reload">搜索</el-button>
    </section>

    <section v-loading="loading" class="library-grid">
      <article v-for="file in files" :key="file.id" class="library-card">
        <div class="thumb-wrap">
          <img v-if="file.thumbnailUrl || file.category === 'IMAGE'" :src="file.thumbnailUrl || file.accessUrl || ''" alt="" />
          <div v-else class="thumb-fallback">{{ file.extension || file.category }}</div>
        </div>
        <div class="card-body">
          <h3 :title="file.originalName">{{ file.originalName }}</h3>
          <p class="meta">{{ formatSize(file.size) }} · {{ file.category }}</p>
          <div class="card-actions">
            <el-button v-if="file.accessUrl" link type="primary" @click="openFile(file)">打开</el-button>
            <el-button v-if="file.accessUrl" link type="primary" @click="downloadFile(file)">下载</el-button>
          </div>
        </div>
      </article>
      <el-empty v-if="!loading && files.length === 0" description="暂无公开文件" />
    </section>

    <div v-if="total > pageSize" class="pager">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        layout="prev, pager, next, total"
        :total="total"
        @current-change="reload"
      />
    </div>
  </main>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { http } from '@/api/http';
import type { ManagedFile } from '@/types';

const route = useRoute();
const slug = ref(String(route.params.slug || ''));
const library = ref<{ name?: string; description?: string | null; slug?: string } | null>(null);
const files = ref<ManagedFile[]>([]);
const loading = ref(false);
const keyword = ref('');
const category = ref('');
const sort = ref<'newest' | 'oldest' | 'name' | 'size'>('newest');
const page = ref(1);
const pageSize = 20;
const total = ref(0);

function applySeo(meta: { name?: string; description?: string | null; slug?: string } | null): void {
  const title = meta?.name ? `${meta.name} · 公开资源库` : '公开资源库';
  document.title = title;
  const description = meta?.description || '浏览公开发布的文件资源。';
  let tag = document.querySelector('meta[name="description"]');
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', 'description');
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', description);
}

async function reload(): Promise<void> {
  if (!slug.value) {
    return;
  }
  loading.value = true;
  try {
    const [meta, list] = await Promise.all([
      http.get<unknown, { name?: string; description?: string | null; slug?: string }>(`/library/${slug.value}`),
      http.get<unknown, { items: ManagedFile[]; total: number; page: number; pageSize: number }>(
        `/library/${slug.value}/files`,
        {
          params: {
            q: keyword.value || undefined,
            category: category.value || undefined,
            sort: sort.value,
            page: page.value,
            pageSize,
          },
        },
      ),
    ]);
    library.value = meta;
    applySeo(meta);
    files.value = list.items || [];
    total.value = list.total || 0;
  } catch (error) {
    files.value = [];
    total.value = 0;
    ElMessage.error(error instanceof Error ? error.message : '资源库加载失败。');
  } finally {
    loading.value = false;
  }
}

function openFile(file: ManagedFile): void {
  if (file.accessUrl) {
    window.open(file.accessUrl, '_blank', 'noopener,noreferrer');
  }
}

function downloadFile(file: ManagedFile): void {
  if (!file.accessUrl) {
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = file.accessUrl;
  anchor.download = file.originalName;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  anchor.click();
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

watch(
  () => route.params.slug,
  (value) => {
    slug.value = String(value || '');
    page.value = 1;
    void reload();
  },
);

onMounted(reload);
</script>

<style scoped>
.library-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px 20px 48px;
}

.library-hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 20px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #64748b;
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.library-hero h1 {
  margin: 0;
  font-size: 28px;
}

.muted {
  color: #64748b;
}

.library-toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}

.library-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
  min-height: 180px;
}

.library-card {
  overflow: hidden;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
}

.thumb-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 140px;
  background: #f8fafc;
  overflow: hidden;
}

.thumb-wrap img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-fallback {
  color: #94a3b8;
  font-size: 12px;
  text-transform: uppercase;
}

.card-body {
  padding: 12px;
}

.card-body h3 {
  margin: 0 0 6px;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  margin: 0 0 8px;
  color: #64748b;
  font-size: 12px;
}

.card-actions {
  display: flex;
  gap: 4px;
}

.pager {
  display: flex;
  justify-content: center;
  margin-top: 20px;
}
</style>
