<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">开发对接</h1>
        <p class="page-subtitle">给其他项目接入统一文件管理：获取 AppID、重置 AppSecret、复制签名规则和调用示例。</p>
      </div>
      <div class="toolbar">
        <el-button :icon="Refresh" :loading="loading" @click="loadProjects">刷新项目</el-button>
      </div>
    </div>

    <section class="integration-hero">
      <div>
        <div class="eyebrow">Open API</div>
        <h2>其他项目只需要 AppID、AppSecret 和签名头即可接入。</h2>
        <p>后台不会再次明文展示 AppSecret，密钥遗失时只能重置，旧密钥会立即失效。</p>
      </div>
      <div class="hero-steps">
        <div>1. 选择项目</div>
        <div>2. 保存 AppID / AppSecret</div>
        <div>3. 按规则签名请求</div>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="toolbar">
          <el-select
            v-model="selectedProjectId"
            filterable
            placeholder="选择要对接的项目"
            class="project-select"
            @change="handleProjectChange"
          >
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-tag v-if="selectedProject?.canManage" type="success">可管理密钥</el-tag>
          <el-tag v-else-if="selectedProject" type="info">只读查看</el-tag>
        </div>
      </div>
    </section>

    <el-empty v-if="!selectedProject && !loading" description="暂无可对接项目" />

    <template v-else-if="selectedProject">
      <div class="integration-grid">
        <section class="surface">
          <div class="surface-body credential-panel">
            <div class="section-heading">
              <div>
                <h2>项目凭证</h2>
                <p class="muted">AppID 可公开用于标识项目，AppSecret 必须只保存在调用方服务端。</p>
              </div>
              <el-button
                v-if="selectedProject.canManage"
                type="primary"
                :icon="Key"
                :loading="resettingSecret"
                @click="resetSecret"
              >
                重置 AppSecret
              </el-button>
            </div>

            <el-descriptions :column="1" border>
              <el-descriptions-item label="项目">
                {{ selectedProject.name }}
              </el-descriptions-item>
              <el-descriptions-item label="AppID">
                <div class="copy-line">
                  <span class="mono breakable">{{ selectedProject.appId }}</span>
                  <el-button link type="primary" :icon="CopyDocument" @click="copyText(selectedProject.appId)">
                    复制
                  </el-button>
                </div>
              </el-descriptions-item>
              <el-descriptions-item label="API 根地址">
                <div class="copy-line">
                  <span class="mono breakable">{{ apiBaseUrl }}</span>
                  <el-button link type="primary" :icon="CopyDocument" @click="copyText(apiBaseUrl)">复制</el-button>
                </div>
              </el-descriptions-item>
              <el-descriptions-item label="开发默认后端">
                <span class="mono">http://localhost:60557/api</span>
              </el-descriptions-item>
              <el-descriptions-item label="当前存储">
                {{ activeStorageText }}
              </el-descriptions-item>
              <el-descriptions-item label="域名白名单">
                {{ allowedDomainsText }}
              </el-descriptions-item>
            </el-descriptions>

            <el-alert
              type="warning"
              show-icon
              :closable="false"
              title="AppSecret 不会在此页面明文展示；如果没有保存，只能重置并更新所有调用方配置。"
            />
          </div>
        </section>

        <section class="surface">
          <div class="surface-body">
            <div class="section-heading">
              <div>
                <h2>签名规则</h2>
                <p class="muted">所有开放接口都使用 HMAC-SHA256 十六进制签名，请求体以其 SHA-256 摘要参与签名（文件上传为流式传输，body 摘要按空字符串计算）。</p>
              </div>
            </div>

            <div class="rule-list">
              <div v-for="header in signatureHeaders" :key="header.name" class="rule-item">
                <span class="mono">{{ header.name }}</span>
                <span>{{ header.description }}</span>
              </div>
            </div>

            <div class="payload-card">
              <div class="payload-title">签名载荷</div>
              <pre class="code-block compact">{{ signedPayloadTemplate }}</pre>
              <el-button link type="primary" :icon="CopyDocument" @click="copyText(signedPayloadTemplate)">
                复制载荷模板
              </el-button>
            </div>

            <el-alert
              type="info"
              show-icon
              :closable="false"
              title="PATH 必须使用实际请求路径，例如 /api/open/files；query 按 key 升序拼接为 key=value，空 query 保留空行；最后一行是请求体的 SHA-256 十六进制摘要（无 body 时为空字符串摘要 e3b0c442...）。"
            />
          </div>
        </section>
      </div>

      <section class="surface">
        <div class="surface-body">
          <div class="section-heading">
            <div>
              <h2>开放接口</h2>
              <p class="muted">开放接口只操作当前 AppID 所属项目的数据。</p>
            </div>
          </div>

          <el-table :data="endpoints" class="endpoint-table">
            <el-table-column prop="method" label="方法" width="100">
              <template #default="{ row }">
                <el-tag :type="row.method === 'GET' ? 'success' : 'warning'">{{ row.method }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="path" label="路径" min-width="260">
              <template #default="{ row }">
                <span class="mono">{{ row.path }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="usage" label="用途" min-width="220" />
            <el-table-column prop="notes" label="参数说明" min-width="260" show-overflow-tooltip />
          </el-table>
        </div>
      </section>

      <section class="surface">
        <div class="surface-body">
          <div class="section-heading">
            <div>
              <h2>调用示例</h2>
              <p class="muted">示例中的 AppSecret 建议通过环境变量注入，不要写进前端代码或仓库。</p>
            </div>
          </div>

          <el-tabs v-model="activeExample" class="example-tabs">
            <el-tab-pane label="Node.js 查询" name="node">
              <div class="code-actions">
                <el-button :icon="CopyDocument" @click="copyText(nodeExample)">复制 Node.js 示例</el-button>
              </div>
              <pre class="code-block">{{ nodeExample }}</pre>
            </el-tab-pane>
            <el-tab-pane label="PowerShell 查询" name="powershell">
              <div class="code-actions">
                <el-button :icon="CopyDocument" @click="copyText(powershellExample)">复制 PowerShell 示例</el-button>
              </div>
              <pre class="code-block">{{ powershellExample }}</pre>
            </el-tab-pane>
            <el-tab-pane label="上传说明" name="upload">
              <div class="code-actions">
                <el-button :icon="CopyDocument" @click="copyText(uploadExample)">复制上传示例</el-button>
              </div>
              <pre class="code-block">{{ uploadExample }}</pre>
            </el-tab-pane>
          </el-tabs>
        </div>
      </section>
    </template>

    <el-dialog v-model="secretDialogVisible" title="项目密钥" width="560px">
      <el-alert
        type="warning"
        show-icon
        :closable="false"
        title="AppSecret 仅展示本次，关闭后无法再次查看。"
      />
      <div class="secret-box">
        <div>
          <span class="muted">AppID</span>
          <div class="copy-line secret-value">
            <span class="mono breakable">{{ latestSecret.appId }}</span>
            <el-button link type="primary" :icon="CopyDocument" @click="copyText(latestSecret.appId)">复制</el-button>
          </div>
        </div>
        <div>
          <span class="muted">AppSecret</span>
          <div class="copy-line secret-value">
            <span class="mono breakable">{{ latestSecret.appSecret }}</span>
            <el-button link type="primary" :icon="CopyDocument" @click="copyText(latestSecret.appSecret)">
              复制
            </el-button>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { CopyDocument, Key, Refresh } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { projectApi } from '@/api/modules';
import type { Project } from '@/types';
import { copyText } from '@/utils/io';

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const resettingSecret = ref(false);
const projects = ref<Project[]>([]);
const selectedProjectId = ref(String(route.query.projectId || ''));
const secretDialogVisible = ref(false);
const activeExample = ref('node');
const latestSecret = reactive({ appId: '', appSecret: '' });
const apiOrigin = inferApiOrigin();
const apiBaseUrl = computed(() => `${apiOrigin}/api`);
const selectedProject = computed(() => projects.value.find((project) => project.id === selectedProjectId.value));
const selectedAppId = computed(() => selectedProject.value?.appId || 'app_xxx');
const activeStorageText = computed(() => {
  const project = selectedProject.value;

  if (!project?.activeCdnName && !project?.activeCdnProvider) {
    return '未配置';
  }

  return [project.activeCdnName, project.activeCdnProvider].filter(Boolean).join(' / ');
});
const allowedDomainsText = computed(() => {
  const domains = selectedProject.value?.allowedDomains || [];
  return domains.length > 0 ? domains.join('、') : '使用系统全局白名单';
});
const signatureHeaders = [
  { name: 'x-app-id', description: '项目 AppID，用于定位项目。' },
  { name: 'x-timestamp', description: 'Unix 秒级时间戳，允许 300 秒偏移。' },
  { name: 'x-nonce', description: '随机字符串，同一 AppID 在有效期内不能重复。' },
  { name: 'x-signature', description: '使用 AppSecret 对签名载荷计算 HMAC-SHA256 hex。' },
];
const signedPayloadTemplate = ['METHOD', 'PATH', 'TIMESTAMP', 'NONCE', 'CANONICAL_QUERY', 'BODY_SHA256'].join('\n');
const endpoints = [
  {
    method: 'GET',
    path: '/api/open/files',
    usage: '查询项目文件',
    notes:
      '支持 keyword、category、status、tag、folderPath、extension、duplicateOnly、page、pageSize。每条记录含 accessUrl / thumbnailUrl：展示图片请直接用这些公开 URL（浏览器可缓存），不要走 download 流。图片变换：accessUrl?w=宽度&h=高度&format=webp|avif|auto（可选 x/y/cw/ch 裁切）。',
  },
  {
    method: 'POST',
    path: '/api/open/files',
    usage: '上传项目文件',
    notes:
      'multipart/form-data，文件字段名为 files；可用 folderPath / duplicateStrategy=reject|reuse|replace / targetFileId query。replace 或 targetFileId 会就地覆盖并保持 fileId、直链与分享页不变。',
  },
  {
    method: 'GET',
    path: '/api/open/files/:fileId',
    usage: '查看文件详情',
    notes:
      '返回文件名、备注、标签、目录、checksum、accessUrl、thumbnailUrl 等。展示用 accessUrl（/api/public/files/:id，支持 Cache-Control + ETag）；缩略图用 thumbnailUrl（常为 ?w=320&format=webp，immutable 长缓存）。图片可在 accessUrl 后追加变换参数：?w=宽度&h=高度&format=webp|avif|auto、preset=sm|md|lg（sm=320 / md=960 / lg=1600 + webp；可被显式 w/format 覆盖；可选 x/y/cw/ch 裁切），无需二次签名。',
  },
  {
    method: 'PUT',
    path: '/api/open/files/:fileId',
    usage: '更新文件元数据',
    notes: '支持 originalName、remark、tags、folderPath。',
  },
  {
    method: 'GET',
    path: '/api/open/files/:fileId/download',
    usage: '下载项目文件（鉴权流）',
    notes:
      '强制下载 / 私有二进制传输用此接口（响应 Cache-Control: no-store）。图片/外链展示请改用详情里的 accessUrl，不要每次走 download。fileId 必须属于当前 AppID 对应项目。',
  },
  {
    method: 'GET',
    path: '/api/open/files/:fileId/versions',
    usage: '列出文件历史版本',
    notes: '返回 version、size、originalName、mimeType、checksum、createdAt、remark 等；按版本号倒序。',
  },
  {
    method: 'POST',
    path: '/api/open/files/:fileId/versions/:version/restore',
    usage: '恢复到指定历史版本',
    notes: '把文件内容回滚到指定 version；当前 HEAD 会先被快照，便于再次回退。',
  },
  {
    method: 'DELETE',
    path: '/api/open/files/:fileId',
    usage: '移入回收站',
    notes: '不会立即彻底删除，可通过恢复接口恢复。',
  },
  {
    method: 'POST',
    path: '/api/open/files/:fileId/restore',
    usage: '恢复文件',
    notes: '把回收站中的文件恢复为有效文件。',
  },
  {
    method: 'POST',
    path: '/api/open/files/batch/recycle',
    usage: '批量移入回收站',
    notes: 'JSON body：{ "fileIds": ["id1","id2"] }，1–100 个；仅 ACTIVE 文件可回收。',
  },
  {
    method: 'POST',
    path: '/api/open/files/batch/restore',
    usage: '批量从回收站恢复',
    notes: 'JSON body：{ "fileIds": ["id1","id2"] }，1–100 个；仅 RECYCLED 文件可恢复。',
  },
  {
    method: 'GET',
    path: '/api/open/files/quota',
    usage: '查询项目配额与用量',
    notes:
      '返回 usedBytes、usedFiles、quotaBytes、quotaFiles、bytesUsagePercent、filesUsagePercent；仅统计 ACTIVE 文件。',
  },
  {
    method: 'GET',
    path: '/api/open/files/folders',
    usage: '列出项目目录',
    notes: '返回项目下已有 folderPath 列表。',
  },
  {
    method: 'GET',
    path: '/api/open/files/folder-tree',
    usage: '目录树',
    notes: '返回层级目录树结构，便于前端渲染。',
  },
  {
    method: 'GET',
    path: '/api/open/files/search',
    usage: '搜索项目文件',
    notes: 'query：q（关键词）、page、pageSize。',
  },
  {
    method: 'GET',
    path: '/api/open/files/:fileId/shares',
    usage: '查询文件分享',
    notes: '返回分享页 URL、无 /download 的直链下载 URL、状态、过期时间和下载次数。',
  },
  {
    method: 'POST',
    path: '/api/open/files/:fileId/shares',
    usage: '创建文件分享',
    notes: '支持 password、expiresAt、maxDownloads；新直链为 /api/shares/:token，有密码时会先进入分享页校验。',
  },
  {
    method: 'PUT',
    path: '/api/open/files/shares/:shareId',
    usage: '编辑文件分享',
    notes: '支持修改密码、过期时间、下载次数和启用状态。',
  },
  {
    method: 'DELETE',
    path: '/api/open/files/shares/:shareId',
    usage: '停用文件分享',
    notes: '停用后分享页和直链都会失效。',
  },
];
const nodeExample = computed(() =>
  [
    "import { createHash, createHmac, randomUUID } from 'node:crypto';",
    '',
    `const appId = '${selectedAppId.value}';`,
    "const appSecret = process.env.UFM_APP_SECRET || 'sk_xxx';",
    `const origin = process.env.UFM_API_ORIGIN || '${apiOrigin}';`,
    "const method = 'GET';",
    "const path = '/api/open/files';",
    "const query = { page: '1', pageSize: '20' };",
    '',
    'const canonicalQuery = Object.keys(query)',
    '  .sort()',
    '  .map((key) => `${key}=${query[key]}`)',
    "  .join('&');",
    'const timestamp = Math.floor(Date.now() / 1000).toString();',
    'const nonce = randomUUID();',
    "const body = '';",
    "const bodyHash = createHash('sha256').update(body).digest('hex');",
    "const payload = [method, path, timestamp, nonce, canonicalQuery, bodyHash].join('\\n');",
    "const signature = createHmac('sha256', appSecret).update(payload).digest('hex');",
    '',
    'const url = new URL(`${origin}${path}`);',
    'Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));',
    '',
    'const response = await fetch(url, {',
    '  headers: {',
    "    'x-app-id': appId,",
    "    'x-timestamp': timestamp,",
    "    'x-nonce': nonce,",
    "    'x-signature': signature,",
    '  },',
    '});',
    '',
    'console.log(await response.json());',
  ].join('\n'),
);
const powershellExample = computed(() =>
  [
    `$appId = "${selectedAppId.value}"`,
    '$appSecret = $env:UFM_APP_SECRET',
    `$origin = "${apiOrigin}"`,
    '$method = "GET"',
    '$path = "/api/open/files"',
    '$query = "page=1&pageSize=20"',
    '$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()',
    '$nonce = [guid]::NewGuid().ToString()',
    '$body = ""',
    '$sha = [System.Security.Cryptography.SHA256]::Create()',
    '$bodyHash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($body)) | ForEach-Object { $_.ToString("x2") })',
    '$payload = "$method`n$path`n$timestamp`n$nonce`n$query`n$bodyHash"',
    '',
    '$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($appSecret))',
    '$signature = -join ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($payload)) | ForEach-Object { $_.ToString("x2") })',
    '',
    'Invoke-RestMethod -Uri "$origin$path?$query" -Headers @{',
    '  "x-app-id" = $appId',
    '  "x-timestamp" = $timestamp',
    '  "x-nonce" = $nonce',
    '  "x-signature" = $signature',
    '}',
  ].join('\n'),
);
const uploadExample = computed(() =>
  [
    '上传接口签名载荷示例。query 为空时该行为空字符串；最后一行为请求体 SHA-256 摘要，',
    '文件上传为流式传输不缓冲，因此 body 摘要按空字符串计算（固定为 e3b0c442...）：',
    '',
    'POST',
    '/api/open/files',
    'TIMESTAMP',
    'NONCE',
    '',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '',
    'curl 调用形态：',
    `curl -X POST "${apiOrigin}/api/open/files" \\`,
    `  -H "x-app-id: ${selectedAppId.value}" \\`,
    '  -H "x-timestamp: $TIMESTAMP" \\',
    '  -H "x-nonce: $NONCE" \\',
    '  -H "x-signature: $SIGNATURE" \\',
    '  -F "files=@./demo.pdf"',
    '',
    '上传到目录时，PATH 仍为 /api/open/files，folderPath 走 query 参与签名：',
    '/api/open/files?folderPath=contracts/2026',
    '',
    '同名覆盖（保持 fileId / 直链 / 分享不变）：',
    '/api/open/files?folderPath=contracts/2026&duplicateStrategy=replace',
    '',
    '指定文件覆盖：',
    '/api/open/files?targetFileId=FILE_ID&duplicateStrategy=replace',
  ].join('\n'),
);

function inferApiOrigin(): string {
  const { protocol, hostname, port, origin } = window.location;

  if (port === '5173' || port === '5174') {
    return `${protocol}//${hostname}:60557`;
  }

  return origin;
}

async function loadProjects(): Promise<void> {
  loading.value = true;
  try {
    projects.value = await projectApi.list();
    const routeProjectId = String(route.query.projectId || '');
    selectedProjectId.value =
      projects.value.find((project) => project.id === routeProjectId)?.id ||
      selectedProjectId.value ||
      projects.value[0]?.id ||
      '';
    syncProjectRoute();
  } finally {
    loading.value = false;
  }
}

function handleProjectChange(): void {
  syncProjectRoute();
}

function syncProjectRoute(): void {
  if (!selectedProjectId.value || route.query.projectId === selectedProjectId.value) {
    return;
  }

  void router.replace({ path: route.path, query: { projectId: selectedProjectId.value } });
}

async function resetSecret(): Promise<void> {
  const project = selectedProject.value;
  if (!project?.canManage) {
    return;
  }

  await ElMessageBox.confirm('重置后旧 AppSecret 会立即失效，所有已接入项目都必须同步更新新密钥。', '重置密钥', {
    type: 'warning',
    confirmButtonText: '确认重置',
    cancelButtonText: '取消',
  });

  resettingSecret.value = true;
  try {
    const result = await projectApi.resetSecret(project.id);
    latestSecret.appId = result.appId;
    latestSecret.appSecret = result.appSecret;
    secretDialogVisible.value = true;
  } finally {
    resettingSecret.value = false;
  }
}

watch(
  () => route.query.projectId,
  (projectId) => {
    const nextProjectId = String(projectId || '');
    if (nextProjectId && nextProjectId !== selectedProjectId.value) {
      selectedProjectId.value = nextProjectId;
    }
  },
);

onMounted(loadProjects);
</script>

<style scoped>
.integration-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 20px;
  padding: 22px;
  overflow: hidden;
  border: 1px solid #bfdbfe;
  border-radius: 12px;
  background:
    radial-gradient(circle at top right, rgba(37, 99, 235, 0.18), transparent 34%),
    linear-gradient(135deg, #eff6ff, #ffffff 62%);
}

.eyebrow {
  margin-bottom: 8px;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.integration-hero h2,
.section-heading h2 {
  margin: 0;
  font-size: 18px;
  line-height: 1.4;
}

.integration-hero p,
.section-heading p {
  margin: 8px 0 0;
  line-height: 1.6;
}

.hero-steps {
  display: grid;
  gap: 10px;
}

.hero-steps div {
  padding: 12px 14px;
  border: 1px solid rgba(37, 99, 235, 0.16);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.78);
  color: #1e3a8a;
  font-weight: 700;
}

.project-select {
  width: min(100%, 360px);
}

.integration-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.02fr) minmax(0, 0.98fr);
  gap: 16px;
}

.credential-panel {
  display: grid;
  gap: 14px;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.copy-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.breakable {
  overflow-wrap: anywhere;
}

.rule-list {
  display: grid;
  gap: 10px;
}

.rule-item {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-muted);
}

.payload-card {
  margin: 14px 0;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: #ffffff;
}

.payload-title {
  margin-bottom: 8px;
  font-weight: 700;
}

.endpoint-table {
  margin-top: 4px;
}

.example-tabs {
  margin-top: 4px;
}

.code-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.code-block {
  margin: 0;
  padding: 14px;
  overflow: auto;
  border: 1px solid #1e293b;
  border-radius: 10px;
  background: #0f172a;
  color: #e2e8f0;
  font-family: "Fira Code", "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
}

.code-block.compact {
  background: #111827;
}

.secret-box {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}

.secret-value {
  margin-top: 6px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-muted);
}

@media (max-width: 980px) {
  .integration-hero,
  .integration-grid {
    grid-template-columns: 1fr;
  }

  .section-heading {
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .rule-item,
  .copy-line {
    grid-template-columns: 1fr;
  }

  .copy-line {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
