<template>
  <div class="page dashboard-page">
    <div class="page-header">
      <div>
        <h1 class="page-title">系统概览</h1>
        <p class="page-subtitle">源文件、存储副本、下载与备份的运行概况。</p>
      </div>
      <div class="header-actions">
        <el-button @click="refreshAll">刷新概览</el-button><el-button type="primary" @click="$router.push('/projects')">管理项目</el-button>
      </div>
    </div>
    <section
      v-loading="summaryPanel.loading"
      aria-label="关键指标"
      :aria-busy="summaryPanel.loading"
    >
      <div v-if="summaryPanel.error" class="panel-error" role="alert">
        {{ summaryPanel.error
        }}<el-button link type="primary" @click="loadSummary">重试指标</el-button>
      </div>
      <div v-if="summaryPanel.data" class="dashboard-metrics">
        <div class="metric">
          <div class="metric-label">项目总数 / 启用</div>
          <div class="metric-value">
            {{ summaryPanel.data.projects.total
            }}<span class="metric-secondary"> / {{ summaryPanel.data.projects.enabled }}</span>
          </div>
        </div>
        <div class="metric">
          <div class="metric-label">有效文件</div>
          <div class="metric-value">{{ summaryPanel.data.files.active }}</div>
          <div class="metric-note">未删除的 ACTIVE 文件</div>
        </div>
        <div class="metric">
          <div class="metric-label">源文件逻辑体积</div>
          <div
            class="metric-value byte-value"
            :title="`${summaryPanel.data.files.sourceBytes} 字节`"
          >
            {{ formatBytes(summaryPanel.data.files.sourceBytes) }}
          </div>
          <div class="metric-note">每个有效源文件计一次</div>
        </div>
        <div class="metric">
          <div class="metric-label">READY 副本记录体积</div>
          <div
            class="metric-value byte-value"
            :title="`${summaryPanel.data.replicas.readyBytes} 字节`"
          >
            {{ formatBytes(summaryPanel.data.replicas.readyBytes) }}
          </div>
          <div class="metric-note">含历史、派生及回收中对象</div>
        </div>
        <div class="metric">
          <div class="metric-label">启用存储</div>
          <div class="metric-value">{{ summaryPanel.data.storage.enabled }}</div>
          <router-link class="metric-note" to="/storage-configs">查看存储配置</router-link>
        </div>
        <div class="metric">
          <div class="metric-label">待同步副本</div>
          <div class="metric-value">{{ summaryPanel.data.replicas.pending }}</div>
          <div class="metric-note">PENDING / SYNCING</div>
        </div>
        <div class="metric">
          <div class="metric-label">失败 / 缺失副本</div>
          <div
            class="metric-value"
            :class="{ 'danger-text': summaryPanel.data.replicas.failedOrMissing > 0 }"
          >
            {{ summaryPanel.data.replicas.failedOrMissing }}
          </div>
          <div class="metric-note">FAILED / MISSING</div>
        </div>
        <div class="metric">
          <div class="metric-label">运行中 / 失败任务</div>
          <div class="metric-value">
            {{ summaryPanel.data.tasks.running
            }}<span
              class="metric-secondary"
              :class="{ 'danger-text': summaryPanel.data.tasks.failed > 0 }"
            >
              / {{ summaryPanel.data.tasks.failed }}</span>
          </div>
          <router-link class="metric-note" to="/tasks">查看任务记录</router-link>
        </div>
      </div>
      <p v-else-if="!summaryPanel.error" class="empty-message">正在读取关键指标…</p>
      <p class="data-note">
        副本数量与体积来自现有索引，不代表供应商计费空间或实时逐对象校验。<span
          v-if="summaryPanel.data"
        >
          更新于 {{ formatDate(summaryPanel.data.updatedAt) }}。</span>
      </p>
    </section>
    <section
      v-loading="trendPanel.loading"
      class="surface dashboard-surface"
      aria-labelledby="trends-title"
      :aria-busy="trendPanel.loading"
    >
      <div class="panel-heading">
        <div>
          <h2 id="trends-title">下载请求趋势</h2>
          <p>Asia/Shanghai 日期，含 Range 传输请求。</p>
        </div>
        <el-radio-group
          v-model="days"
          size="small"
          aria-label="下载趋势时间范围"
          @change="loadTrends"
          ><el-radio-button :value="7">最近 7 天</el-radio-button><el-radio-button :value="30">最近 30 天</el-radio-button></el-radio-group>
      </div>
      <div v-if="trendPanel.error" class="panel-error" role="alert">
        {{ trendPanel.error
        }}<el-button link type="primary" @click="loadTrends">重试趋势</el-button>
      </div>
      <template v-if="trendPanel.data">
        <div class="trend-totals">
          <span>下载请求 <strong>{{ totalRequests }}</strong></span><span>传输流量
            <strong :title="`${totalTrendBytes} 字节`">{{
              formatBytes(totalTrendBytes)
            }}</strong></span>
        </div>
        <p v-if="totalRequests === 0" class="empty-message">这段时间没有下载请求。</p>
        <div class="chart-grid">
          <figure v-for="chart in trendCharts" :key="chart.id" class="trend-chart">
            <figcaption>
              {{ chart.label }}<span>{{ chart.peakLabel }}</span>
            </figcaption>
            <svg
              viewBox="0 0 600 160"
              role="img"
              :aria-label="`${chart.label}，${trendPanel.data.items.length} 天，${chart.peakLabel}。下方可展开每日明细。`"
              preserveAspectRatio="none"
            >
              <path d="M 12 140 H 588 M 12 80 H 588 M 12 20 H 588" class="chart-gridline" />
              <path :d="chart.area" :class="['chart-area', chart.id]" />
              <polyline :points="chart.points" :class="['chart-line', chart.id]" />
            </svg>
            <div class="chart-axis">
              <span>{{ trendPanel.data.items[0]?.day }}</span><span>{{ trendPanel.data.items.at(-1)?.day }}</span>
            </div>
          </figure>
        </div>
        <details class="trend-details">
          <summary>查看每日请求数和流量</summary>
          <div class="table-scroll">
            <table class="numbers-table">
              <caption class="sr-only">
                上海日期下载请求与流量明细
              </caption>
              <thead>
                <tr>
                  <th scope="col">日期</th>
                  <th scope="col">请求数</th>
                  <th scope="col">流量</th>
                  <th scope="col">字节</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in trendPanel.data.items" :key="item.day">
                  <th scope="row">{{ item.day }}</th>
                  <td>{{ item.requests }}</td>
                  <td>{{ formatBytes(item.bytes) }}</td>
                  <td class="mono">{{ item.bytes }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
        <p class="data-note">
          下载请求数与分享计次独立。更新于 {{ formatDate(trendPanel.data.updatedAt) }}。
        </p>
      </template>
      <p v-else-if="!trendPanel.error" class="empty-message">正在读取下载趋势…</p>
    </section>
    <section
      v-loading="storagePanel.loading"
      class="surface dashboard-surface"
      aria-labelledby="storage-title"
      :aria-busy="storagePanel.loading"
    >
      <div class="panel-heading">
        <div>
          <h2 id="storage-title">存储状态</h2>
          <p>最近已记录检查结果；概览只读取元数据。</p>
        </div>
        <router-link to="/storage-configs">管理存储</router-link>
      </div>
      <div v-if="storagePanel.error" class="panel-error" role="alert">
        {{ storagePanel.error
        }}<el-button link type="primary" @click="loadStorage">重试存储</el-button>
      </div>
      <div v-if="storagePanel.data?.items.length" class="storage-grid">
        <article v-for="storage in storagePanel.data.items" :key="storage.id" class="storage-card">
          <div class="storage-card-title">
            <h3>{{ storage.name }}</h3>
            <el-tag :type="storage.enabled ? 'success' : 'info'" size="small">{{
              storage.enabled ? '启用' : '停用'
            }}</el-tag>
          </div>
          <p class="data-note">
            {{ providerName(storage.provider) }} · 绑定 {{ storage.boundProjects }} 个项目 ·
            全局优先级 {{ storage.priority }}
          </p>
          <div class="health-row">
            <span class="health-dot" :class="storage.health.status.toLowerCase()"></span><strong>{{ healthName(storage.health.status) }}</strong><span>{{
              storage.health.checkedAt ? formatDate(storage.health.checkedAt) : '无检查记录'
            }}</span>
          </div>
          <dl class="storage-stat-grid">
            <div>
              <dt>READY</dt>
              <dd>{{ storage.replicas.ready }}</dd>
            </div>
            <div>
              <dt>待同步</dt>
              <dd>{{ storage.replicas.pending }}</dd>
            </div>
            <div>
              <dt>失败 / 缺失</dt>
              <dd :class="{ 'danger-text': storage.replicas.failedOrMissing > 0 }">
                {{ storage.replicas.failedOrMissing }}
              </dd>
            </div>
          </dl>
          <div class="storage-volume">
            <span>READY 索引体积</span><strong :title="`${storage.replicas.readyBytes} 字节`">{{
              formatBytes(storage.replicas.readyBytes)
            }}</strong>
          </div>
          <div class="storage-volume">
            <span>供应商账户实时用量</span><strong>{{
              storage.accountUsedBytes === null ? '未知' : formatBytes(storage.accountUsedBytes)
            }}</strong>
          </div>
        </article>
      </div>
      <p v-else-if="storagePanel.data" class="empty-message">还没有存储配置。</p>
      <p v-else-if="!storagePanel.error" class="empty-message">正在读取存储状态…</p>
      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="storagePage"
          v-model:page-size="storagePageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="storagePanel.data?.total ?? 0"
          layout="total, sizes, prev, pager, next, jumper"
          :disabled="storagePanel.loading || !storagePanel.data"
          @current-change="loadStorage"
          @size-change="changeStorageSize"
        />
      </div>
      <p v-if="storagePanel.data" class="data-note">
        更新于
        {{
          formatDate(storagePanel.data.updatedAt)
        }}。健康结果是历史检查，供应商用量未知时保持未知。
      </p>
    </section>
    <div v-if="activityPanel.error" class="panel-error" role="alert">
      {{ activityPanel.error
      }}<el-button link type="primary" @click="loadActivity">重试活动与项目</el-button>
    </div>
    <div v-loading="activityPanel.loading" class="activity-grid" :aria-busy="activityPanel.loading">
      <section class="surface dashboard-surface" aria-labelledby="exceptions-title">
        <div class="panel-heading">
          <div>
            <h2 id="exceptions-title">待处理事项</h2>
            <p>优先查看异常与可回收文件。</p>
          </div>
        </div>
        <template v-if="activityPanel.data"><div class="exception-links">
            <router-link to="/tasks"><span>失败任务</span><strong>{{ summaryPanel.data?.tasks.failed ?? '—' }}</strong></router-link><router-link to="/recycle-bin"><span>回收站文件</span><strong>{{ activityPanel.data.exceptions.recycleFiles }}</strong></router-link><router-link to="/backups"><span>最近失败备份</span><strong>{{
                activityPanel.data.backup.lastFailed
                  ? formatDate(activityPanel.data.backup.lastFailed.createdAt)
                  : '无记录'
              }}</strong></router-link>
          </div>
          <h3 class="subheading">失败或缺失副本最多的项目</h3>
          <ul v-if="activityPanel.data.exceptions.replicaProjects.length" class="activity-list">
            <li
              v-for="project in activityPanel.data.exceptions.replicaProjects"
              :key="project.projectId"
            >
              <router-link :to="`/projects/${project.projectId}`">{{
                project.projectName
              }}</router-link><strong class="danger-text">{{ project.failedOrMissing }} 条</strong>
            </li>
          </ul>
          <p v-else class="empty-message">没有失败或缺失的副本记录。</p>
          <h3 class="subheading">最近失败任务</h3>
          <ul v-if="activityPanel.data.exceptions.failedTasks.length" class="activity-list">
            <li v-for="task in activityPanel.data.exceptions.failedTasks" :key="task.id">
              <router-link :to="task.projectId ? `/projects/${task.projectId}` : '/tasks'">{{
                task.title
              }}</router-link><span>{{ formatDate(task.createdAt) }}</span>
            </li>
          </ul>
          <p v-else class="empty-message">没有失败任务记录。</p></template>
        <p v-else class="empty-message">
          {{ activityPanel.error ? '待处理事项加载失败。' : '正在读取待处理事项…' }}
        </p>
      </section>
      <section class="surface dashboard-surface" aria-labelledby="backup-title">
        <div class="panel-heading">
          <div>
            <h2 id="backup-title">最近备份</h2>
            <p>备份状态与对象收录范围。</p>
          </div>
          <router-link to="/backups">管理备份</router-link>
        </div>
        <template v-if="activityPanel.data?.backup.latest"><div class="backup-state">
            <el-tag :type="backupTag(activityPanel.data.backup.latest.status)">{{
              backupName(activityPanel.data.backup.latest.status)
            }}</el-tag>
            <h3>{{ activityPanel.data.backup.latest.name }}</h3>
          </div>
          <dl class="backup-facts">
            <div>
              <dt>创建时间</dt>
              <dd>{{ formatDate(activityPanel.data.backup.latest.createdAt) }}</dd>
            </div>
            <div>
              <dt>结束时间</dt>
              <dd>{{ formatDate(activityPanel.data.backup.latest.finishedAt) }}</dd>
            </div>
            <div>
              <dt>包含文件对象</dt>
              <dd>
                {{ activityPanel.data.backup.latest.includeObjects ? '包含对象' : '仅元数据' }}
              </dd>
            </div>
          </dl>
          <p
            v-if="activityPanel.data.backup.latest.status === 'FAILED'"
            class="data-note danger-text"
          >
            此备份失败，请进入备份管理查看原因。
          </p></template>
        <p v-else class="empty-message">
          {{
            activityPanel.data
              ? '还没有备份记录。'
              : activityPanel.error
                ? '备份信息加载失败。'
                : '正在读取备份信息…'
          }}
        </p>
      </section>
      <section class="surface dashboard-surface" aria-labelledby="recent-title">
        <div class="panel-heading">
          <div>
            <h2 id="recent-title">最近文件</h2>
            <p>最近 10 个有效源文件。</p>
          </div>
        </div>
        <ul v-if="activityPanel.data?.recentFiles.length" class="activity-list">
          <li v-for="file in activityPanel.data.recentFiles" :key="file.id">
            <div>
              <router-link :to="{ path: '/files', query: { projectId: file.projectId } }">{{
                file.name
              }}</router-link><span class="list-detail">{{ file.projectName }} · {{ formatDate(file.createdAt) }}</span>
            </div>
            <strong :title="`${file.size} 字节`">{{ formatBytes(file.size) }}</strong>
          </li>
        </ul>
        <p v-else class="empty-message">
          {{
            activityPanel.data
              ? '还没有有效文件。'
              : activityPanel.error
                ? '最近文件加载失败。'
                : '正在读取最近文件…'
          }}
        </p>
      </section>
      <section class="surface dashboard-surface" aria-labelledby="top-title">
        <div class="panel-heading">
          <div>
            <h2 id="top-title">项目源文件体积排行</h2>
            <p>按有效文件逻辑体积取前 5 个项目。</p>
          </div>
        </div>
        <ol v-if="activityPanel.data?.topProjects.length" class="project-rank">
          <li v-for="(project, index) in activityPanel.data.topProjects" :key="project.id">
            <span class="rank-number">{{ index + 1 }}</span>
            <div class="rank-main">
              <div class="rank-caption">
                <router-link :to="`/projects/${project.id}`">{{ project.name }}</router-link><strong :title="`${project.sourceBytes} 字节`">{{
                  formatBytes(project.sourceBytes)
                }}</strong>
              </div>
              <div class="rank-track" aria-hidden="true">
                <div :style="{ width: `${rankWidth(project.sourceBytes)}%` }"></div>
              </div>
              <span class="list-detail">{{ project.fileCount }} 个有效文件</span>
            </div>
          </li>
        </ol>
        <p v-else class="empty-message">
          {{
            activityPanel.data
              ? '暂无项目文件排行。'
              : activityPanel.error
                ? '项目排行加载失败。'
                : '正在读取项目排行…'
          }}
        </p>
      </section>
    </div>
    <section
      v-loading="activityPanel.loading"
      class="surface dashboard-surface"
      aria-labelledby="projects-title"
      :aria-busy="activityPanel.loading"
    >
      <div class="panel-heading">
        <div>
          <h2 id="projects-title">项目列表</h2>
          <p>存储按全局 priority 升序，同值按配置 ID；云优先、本地兜底。</p>
        </div>
        <router-link to="/projects">管理项目</router-link>
      </div>
      <el-table
        :data="activityPanel.data?.projects.items ?? []"
        row-key="id"
        :empty-text="activityPanel.error ? '项目加载失败' : '暂无项目'"
        ><el-table-column label="项目" min-width="160"><template #default="{ row }"><router-link :to="`/projects/${row.id}`">{{ row.name }}</router-link></template></el-table-column><el-table-column label="状态" width="90"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{
              row.enabled ? '启用' : '停用'
            }}</el-tag></template></el-table-column><el-table-column label="使用的存储" min-width="300"><template #default="{ row }"><div v-if="row.storages.length" class="storage-tags">
              <el-tag
                v-for="storage in row.storages"
                :key="storage.id"
                :type="
                  storage.enabled ? (storage.provider === 'LOCAL' ? 'info' : 'primary') : 'warning'
                "
                size="small"
                >{{ storage.name }} · {{ storage.enabled ? '启用' : '停用' }} ·
                {{
                  storage.provider === 'LOCAL' ? '本地兜底' : `优先级 ${storage.priority}`
                }}</el-tag>
            </div>
            <span v-else class="data-note">未配置存储</span></template></el-table-column><el-table-column prop="fileCount" label="有效文件" width="100" /><el-table-column
          label="操作"
          width="90"
          ><template #default="{ row }"><el-button link type="primary" @click="$router.push(`/projects/${row.id}`)">查看</el-button></template></el-table-column></el-table>
      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="projectPage"
          v-model:page-size="projectPageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="activityPanel.data?.projects.total ?? 0"
          layout="total, sizes, prev, pager, next, jumper"
          :disabled="activityPanel.loading || !activityPanel.data"
          @current-change="loadActivity"
          @size-change="changeProjectSize"
        />
      </div>
      <p class="data-note">
        存储标签表示项目配置关系，文件的实际副本请进入文件详情查看。<span v-if="activityPanel.data">
          活动与项目更新于 {{ formatDate(activityPanel.data.updatedAt) }}。</span>
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
/* global AbortController, AbortSignal */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { dashboardApi } from '@/api/dashboard';
import type {
  DashboardActivity,
  DashboardPage,
  DashboardStorage,
  DashboardSummary,
  DashboardTrends,
} from '@/api/dashboard';

type Panel<T> = { data: T | null; loading: boolean; error: string };
const summaryPanel = reactive<Panel<DashboardSummary>>({ data: null, loading: false, error: '' });
const trendPanel = reactive<Panel<DashboardTrends>>({ data: null, loading: false, error: '' });
const storagePanel = reactive<Panel<DashboardPage<DashboardStorage> & { updatedAt: string }>>({
  data: null,
  loading: false,
  error: '',
});
const activityPanel = reactive<Panel<DashboardActivity>>({ data: null, loading: false, error: '' });
const days = ref<7 | 30>(7);
const projectPage = ref(1),
  projectPageSize = ref(20),
  storagePage = ref(1),
  storagePageSize = ref(20);
const controllers = new Map<string, AbortController>();
let disposed = false;
async function readPanel<T>(
  panel: Panel<T>,
  key: string,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<boolean> {
  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);
  panel.loading = true;
  panel.error = '';
  try {
    const data = await read(controller.signal);
    if (disposed || controller.signal.aborted || controllers.get(key) !== controller) return false;
    panel.data = data;
    return true;
  } catch {
    if (!disposed && !controller.signal.aborted && controllers.get(key) === controller)
      panel.error = panel.data ? '加载失败，请重试。当前显示上次读取结果。' : '加载失败，请重试。';
    return false;
  } finally {
    if (!disposed && controllers.get(key) === controller) panel.loading = false;
  }
}
function loadSummary() {
  return readPanel(summaryPanel, 'summary', (signal) =>
    dashboardApi.summary({ signal, _silent: true }),
  );
}
function loadTrends() {
  const span = days.value;
  return readPanel(trendPanel, 'trends', (signal) =>
    dashboardApi.trends(span, { signal, _silent: true }),
  );
}
async function loadStorage() {
  const page = storagePage.value,
    size = storagePageSize.value;
  const applied = await readPanel(storagePanel, 'storage', (signal) =>
    dashboardApi.storage(page, size, { signal, _silent: true }),
  );
  if (
    applied &&
    !disposed &&
    storagePage.value === page &&
    storagePageSize.value === size &&
    storagePanel.data
  )
    storagePage.value = storagePanel.data.page;
}
async function loadActivity() {
  const page = projectPage.value,
    size = projectPageSize.value;
  const applied = await readPanel(activityPanel, 'activity', (signal) =>
    dashboardApi.activity(page, size, { signal, _silent: true }),
  );
  if (
    applied &&
    !disposed &&
    projectPage.value === page &&
    projectPageSize.value === size &&
    activityPanel.data
  )
    projectPage.value = activityPanel.data.projects.page;
}
function changeProjectSize() {
  projectPage.value = 1;
  return loadActivity();
}
function changeStorageSize() {
  storagePage.value = 1;
  return loadStorage();
}
function refreshAll() {
  return Promise.all([loadSummary(), loadTrends(), loadStorage(), loadActivity()]);
}
onMounted(refreshAll);
onUnmounted(() => {
  disposed = true;
  controllers.forEach((controller) => controller.abort());
});
function formatBytes(value: string): string {
  const bytes = BigInt(value),
    units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let index = 0,
    divisor = 1n;
  while (bytes >= divisor * 1024n && index < units.length - 1) {
    divisor *= 1024n;
    index++;
  }
  if (!index) return `${bytes} B`;
  const tenths = (bytes * 10n) / divisor;
  return `${tenths / 10n}.${tenths % 10n} ${units[index]}`;
}
function formatDate(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : '—';
}
function providerName(provider: string) {
  return (
    (
      {
        LOCAL: '本地存储',
        S3: 'S3',
        ALIYUN_OSS: '阿里云 OSS',
        QINIU: '七牛云',
        UPYUN: '又拍云',
      } as Record<string, string>
    )[provider] ?? provider
  );
}
function healthName(status: string) {
  return (
    (
      { HEALTHY: '最近检查通过', FAILED: '最近检查失败', UNKNOWN: '未检查 / 结果未知' } as Record<
        string,
        string
      >
    )[status] ?? '结果未知'
  );
}
function backupName(status: string) {
  return (
    (
      {
        PENDING: '等待备份',
        RUNNING: '备份中',
        SUCCEEDED: '备份成功',
        FAILED: '备份失败',
      } as Record<string, string>
    )[status] ?? status
  );
}
function backupTag(status: string): 'success' | 'danger' | 'warning' | 'info' {
  return status === 'SUCCEEDED'
    ? 'success'
    : status === 'FAILED'
      ? 'danger'
      : status === 'RUNNING'
        ? 'warning'
        : 'info';
}
const totalRequests = computed(
  () => trendPanel.data?.items.reduce((sum, row) => sum + row.requests, 0) ?? 0,
);
const totalTrendBytes = computed(() =>
  (trendPanel.data?.items.reduce((sum, row) => sum + BigInt(row.bytes), 0n) ?? 0n).toString(),
);
const trendCharts = computed(() => {
  const items = trendPanel.data?.items ?? [];
  return ['requests', 'traffic'].map((id) => {
    const values = items.map((row) =>
      id === 'requests' ? BigInt(row.requests) : BigInt(row.bytes),
    );
    const maximum = values.reduce((a, b) => (a > b ? a : b), 0n);
    const points = values
      .map(
        (value, index) =>
          `${12 + (values.length > 1 ? index / (values.length - 1) : 0) * 576},${140 - (maximum > 0n ? Number((value * 12000n) / maximum) / 100 : 0)}`,
      )
      .join(' ');
    return {
      id,
      label: id === 'requests' ? '下载请求数' : '传输流量',
      peakLabel:
        id === 'requests' ? `峰值 ${maximum} 次请求` : `峰值 ${formatBytes(maximum.toString())}`,
      points,
      area: points ? `M 12 140 L ${points.replaceAll(' ', ' L ')} L 588 140 Z` : '',
    };
  });
});
function rankWidth(bytes: string): number {
  const first = BigInt(activityPanel.data?.topProjects[0]?.sourceBytes ?? '0');
  return first > 0n ? Number((BigInt(bytes) * 10000n) / first) / 100 : 0;
}
</script>

<style scoped>
.dashboard-page {
  min-width: 0;
}
.header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.header-actions .el-button + .el-button {
  margin-left: 0;
}
.dashboard-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}
.metric {
  min-width: 0;
}
.metric-value {
  overflow-wrap: anywhere;
}
.metric-secondary {
  font-size: 0.65em;
  color: var(--el-text-color-secondary);
}
.byte-value {
  font-size: clamp(21px, 2vw, 30px);
}
.metric-note {
  display: block;
  margin-top: 7px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.data-note {
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
.dashboard-surface {
  padding: 22px;
  min-width: 0;
}
.panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 18px;
}
.panel-heading h2 {
  margin: 0;
  font-size: 17px;
}
.panel-heading p {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
.panel-heading > a {
  font-size: 13px;
}
.panel-error {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  margin-bottom: 14px;
  border: 1px solid var(--el-color-danger-light-7);
  background: var(--el-color-danger-light-9);
  border-radius: 8px;
  font-size: 13px;
  color: var(--el-color-danger);
}
.empty-message {
  padding: 22px 6px;
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.danger-text {
  color: var(--el-color-danger);
}
.trend-totals {
  display: flex;
  flex-wrap: wrap;
  gap: 28px;
  font-size: 13px;
}
.trend-totals strong {
  font-size: 21px;
  margin-left: 8px;
}
.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px;
  margin-top: 20px;
}
.trend-chart {
  margin: 0;
  min-width: 0;
}
.trend-chart figcaption {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: space-between;
  font-size: 12px;
}
.trend-chart figcaption span,
.chart-axis {
  color: var(--el-text-color-secondary);
}
.trend-chart svg {
  display: block;
  width: 100%;
  height: 160px;
  margin-top: 10px;
  overflow: visible;
}
.chart-gridline {
  fill: none;
  stroke: var(--el-border-color-lighter);
  stroke-width: 1;
}
.chart-line {
  fill: none;
  stroke-width: 2.5;
  vector-effect: non-scaling-stroke;
}
.chart-line.requests {
  stroke: var(--el-color-primary);
}
.chart-line.traffic {
  stroke: var(--el-color-success);
}
.chart-area.requests {
  fill: var(--el-color-primary-light-9);
}
.chart-area.traffic {
  fill: var(--el-color-success-light-9);
}
.chart-axis {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
}
.trend-details {
  margin-top: 22px;
  font-size: 13px;
}
.trend-details summary {
  cursor: pointer;
  color: var(--el-color-primary);
}
.table-scroll {
  overflow-x: auto;
  margin-top: 12px;
}
.numbers-table {
  width: 100%;
  text-align: left;
  border-collapse: collapse;
  font-size: 12px;
}
.numbers-table th,
.numbers-table td {
  padding: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  white-space: nowrap;
}
.storage-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.storage-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  padding: 16px;
  min-width: 0;
}
.storage-card-title {
  display: flex;
  gap: 8px;
  justify-content: space-between;
  align-items: flex-start;
}
.storage-card-title h3 {
  margin: 0;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.health-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin: 14px 0;
  font-size: 12px;
}
.health-row > span:last-child {
  color: var(--el-text-color-secondary);
}
.health-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}
.health-dot.healthy {
  background: var(--el-color-success);
}
.health-dot.failed {
  background: var(--el-color-danger);
}
.storage-stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 16px 0;
}
.storage-stat-grid dt {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.storage-stat-grid dd {
  margin: 5px 0 0;
  font-size: 21px;
  font-weight: 650;
}
.storage-volume {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  margin-top: 9px;
  font-size: 12px;
}
.storage-volume span {
  color: var(--el-text-color-secondary);
}
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
  overflow-x: auto;
  padding-bottom: 5px;
}
.pagination-wrap :deep(.el-pagination) {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px;
}
.activity-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.exception-links {
  display: grid;
  gap: 10px;
}
.exception-links a {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  padding: 11px 12px;
  border-radius: 7px;
  background: var(--el-fill-color-light);
}
.subheading {
  font-size: 13px;
  margin: 22px 0 6px;
}
.activity-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.activity-list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  padding: 11px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 13px;
}
.activity-list li > a,
.activity-list li > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.activity-list li > span,
.activity-list li > strong {
  flex-shrink: 0;
  font-size: 12px;
}
.activity-list li > span {
  color: var(--el-text-color-secondary);
}
.list-detail {
  display: block;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 5px;
}
.backup-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.backup-state h3 {
  font-size: 16px;
  overflow-wrap: anywhere;
}
.backup-facts {
  margin: 18px 0;
}
.backup-facts > div {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  font-size: 13px;
  margin-top: 16px;
}
.backup-facts dt {
  color: var(--el-text-color-secondary);
}
.backup-facts dd {
  margin: 0;
}
.project-rank {
  list-style: none;
  margin: 0;
  padding: 0;
}
.project-rank li {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin: 20px 0;
}
.rank-number {
  width: 23px;
  height: 23px;
  text-align: center;
  line-height: 23px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  border-radius: 6px;
  font-size: 12px;
}
.rank-main {
  flex: 1;
  min-width: 0;
}
.rank-caption {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.rank-caption a {
  overflow-wrap: anywhere;
}
.rank-caption strong {
  flex-shrink: 0;
  font-size: 12px;
}
.rank-track {
  height: 6px;
  background: var(--el-fill-color-light);
  margin-top: 9px;
  border-radius: 9px;
  overflow: hidden;
}
.rank-track > div {
  height: 100%;
  background: var(--el-color-primary);
  border-radius: inherit;
}
.storage-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 3px 0;
}
.storage-tags :deep(.el-tag) {
  height: auto;
  white-space: normal;
  line-height: 1.7;
  padding: 3px 7px;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 1100px) {
  .storage-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 760px) {
  .dashboard-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .activity-grid,
  .chart-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .dashboard-surface {
    padding: 16px;
  }
  .metric-value {
    font-size: 25px;
  }
  .byte-value {
    font-size: 21px;
  }
  .activity-list li {
    flex-wrap: wrap;
  }
}
@media (max-width: 450px) {
  .storage-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .dashboard-surface {
    padding: 12px;
  }
  .metric {
    padding: 14px 12px;
  }
  .metric-label {
    font-size: 11px;
  }
  .metric-value,
  .byte-value {
    font-size: 21px;
  }
  .trend-totals {
    gap: 12px;
  }
  .trend-totals strong {
    font-size: 18px;
  }
  .pagination-wrap :deep(.el-pagination) {
    justify-content: flex-start;
    font-size: 12px;
  }
}
</style>
