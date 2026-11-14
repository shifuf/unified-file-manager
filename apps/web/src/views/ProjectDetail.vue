<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ project?.name || '项目详情' }}</h1>
        <p class="page-subtitle">{{ project?.description || '查看项目凭证、存储状态和近期文件。' }}</p>
      </div>
      <div class="toolbar">
        <input ref="importInputRef" type="file" accept="application/json,.json" class="hidden-input" @change="importProject" />
        <el-button :icon="Back" @click="$router.push('/projects')">返回项目</el-button>
        <el-button v-if="project?.canManage" :icon="Download" @click="exportProject">导出项目</el-button>
        <el-button v-if="project?.canManage" :icon="UploadFilled" @click="importInputRef?.click()">导入项目</el-button>
        <el-button type="primary" :icon="Upload" @click="$router.push({ path: '/files', query: { projectId } })">
          管理文件
        </el-button>
      </div>
    </div>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div class="section-title">目录管理</div>
          <div class="toolbar">
            <el-button size="small" :loading="directoriesLoading" @click="loadDirectories">刷新目录</el-button>
            <el-button size="small" type="primary" @click="createDirectory()">新建目录</el-button>
          </div>
        </div>
        <p class="muted">支持创建多级目录。目录有文件时请先删除文件；有子目录时请先删除子目录。删除空目录后，回收站文件仍可恢复。</p>
        <el-alert v-if="directoriesError" :title="directoriesError" type="warning" :closable="false" />
        <el-tree v-loading="directoriesLoading" :data="projectFolders" node-key="path" :props="{ label: 'name', children: 'children' }" :expand-on-click-node="false" empty-text="暂无目录，可新建目录后上传文件。">
          <template #default="{ data }">
            <div class="directory-node">
              <span>{{ data.name }} <span class="muted">{{ data.fileCount }} 个文件</span></span>
              <span>
                <el-button link size="small" type="primary" @click.stop="openDirectory(data.path)">管理文件</el-button>
                <el-button link size="small" type="primary" @click.stop="createDirectory(data.path)">新建子目录</el-button>
                <el-button link size="small" type="danger" @click.stop="removeDirectory(data.path)">删除目录</el-button>
              </span>
            </div>
          </template>
        </el-tree>
      </div>
    </section>

    <section class="metric-grid">
      <div class="metric">
        <div class="metric-label">AppID</div>
        <div class="metric-value mono small-value">{{ project?.appId }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">总容量</div>
        <div class="metric-value">{{ formatSize(stats?.totalSize || 0) }}</div>
        <div v-if="stats?.quotaBytes" class="metric-sub">
          配额 {{ formatSize(stats.quotaBytes) }} · {{ stats.bytesUsagePercent ?? 0 }}%
          <el-progress
            :percentage="Math.min(100, stats.bytesUsagePercent || 0)"
            :stroke-width="8"
            :show-text="false"
            style="margin-top: 6px"
          />
        </div>
      </div>
      <div class="metric">
        <div class="metric-label">文件数量</div>
        <div class="metric-value">{{ stats?.fileCount ?? project?.fileCount ?? 0 }}</div>
        <div v-if="stats?.quotaFiles" class="metric-sub">
          配额 {{ stats.quotaFiles }} · {{ stats.filesUsagePercent ?? 0 }}%
          <el-progress
            :percentage="Math.min(100, stats.filesUsagePercent || 0)"
            :stroke-width="8"
            :show-text="false"
            style="margin-top: 6px"
          />
        </div>
      </div>
      <div class="metric">
        <div class="metric-label">重复文件</div>
        <div class="metric-value">{{ stats?.duplicateCount || 0 }}</div>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">下载流量统计（近 {{ downloadDays }} 日）</div>
            <div class="muted">统计所有下载入口：后台、开放 API、公开访问、分享与 WebDAV。</div>
          </div>
          <el-select v-model="downloadDays" size="small" style="width: 130px" @change="changeDownloadDays">
            <el-option :value="1" label="近 1 日" />
            <el-option :value="7" label="近 7 日" />
            <el-option :value="30" label="近 30 日" />
            <el-option :value="90" label="近 90 日" />
          </el-select>
        </div>

        <el-alert v-if="downloadSummaryError" :title="downloadSummaryError" type="error" :closable="false" />
        <div v-loading="downloadSummaryLoading" class="metric-grid">
          <div class="metric">
            <div class="metric-label">下载流量</div>
            <div class="metric-value">{{ downloadSummary ? formatSize(downloadSummary.totalBytes) : '未知' }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">下载请求数</div>
            <div class="metric-value">{{ downloadSummary?.totalCount ?? '未知' }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">成功 / 失败</div>
            <div class="metric-value small-value">
              {{ downloadSummary?.successCount ?? '未知' }} / {{ downloadSummary?.failedCount ?? '未知' }}
            </div>
          </div>
        </div>

        <el-row :gutter="16" style="margin-top: 12px">
          <el-col :xs="24" :md="12">
            <div class="muted" style="margin-bottom: 8px">按来源统计</div>
            <el-table :data="downloadSummary?.bySource || []" size="small" empty-text="暂无下载数据">
              <el-table-column label="来源" min-width="120">
                <template #default="{ row }">{{ sourceLabel(row.source) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="次数" width="90" />
              <el-table-column label="流量" width="130">
                <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
              </el-table-column>
            </el-table>
          </el-col>
          <el-col :xs="24" :md="12">
            <div class="muted" style="margin-bottom: 8px">下载最多的文件</div>
            <el-table :data="downloadSummary?.byFile || []" size="small" empty-text="暂无下载数据">
              <el-table-column label="文件" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">{{ row.originalName || row.fileId || '-' }}</template>
              </el-table-column>
              <el-table-column prop="count" label="次数" width="90" />
              <el-table-column label="流量" width="130">
                <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
              </el-table-column>
            </el-table>
          </el-col>
        </el-row>

        <div class="section-head" style="margin-top: 16px"><div class="muted">最近下载明细</div><el-button size="small" :loading="downloadLoading" @click="loadDownloadItems">刷新明细</el-button></div>
        <el-alert v-if="downloadError" :title="downloadError" type="error" :closable="false" />
        <el-table v-loading="downloadLoading" :data="downloadItems" size="small" empty-text="暂无下载记录">
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="文件" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ row.originalName || row.fileId || '-' }}</template>
          </el-table-column>
          <el-table-column label="来源" width="110">
            <template #default="{ row }">{{ sourceLabel(row.source) }}</template>
          </el-table-column>
          <el-table-column prop="message" label="实际下载存储／切换原因" min-width="300"><template #default="{ row }">{{ row.message || '历史记录未记录下载存储' }}</template></el-table-column>
          <el-table-column label="流量" width="110">
            <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
          </el-table-column>
          <el-table-column prop="ip" label="IP" min-width="130" show-overflow-tooltip />
          <el-table-column label="结果" width="80">
            <template #default="{ row }">
              <el-tag :type="row.success ? 'success' : 'danger'" size="small">
                {{ row.success ? '成功' : '失败' }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          :current-page="downloadPage"
          :page-size="downloadPageSize"
          :page-sizes="pageSizes"
          :total="downloadTotal"
          layout="total, sizes, prev, pager, next, jumper"
          class="panel-pagination"
          :pager-count="5"
          @update:current-page="changeDownloadPage"
          @update:page-size="changeDownloadPageSize"
        />
      </div>
    </section>

    <section v-if="stats?.uploadTrend?.length" class="surface">
      <div class="surface-body">
        <div class="section-title">近 30 日上传趋势</div>
        <div class="trend-bars">
          <div v-for="item in stats.uploadTrend" :key="item.date" class="trend-bar" :title="`${item.date}: ${item.count} 个 / ${formatSize(item.size)}`">
            <div class="trend-fill" :style="{ height: `${trendHeight(item.count)}%` }" />
            <div class="trend-label">{{ item.date.slice(5) }}</div>
          </div>
        </div>
      </div>
    </section>

    <section v-if="stats?.topFilesBySize?.length" class="surface">
      <div class="surface-body">
        <div class="section-title">体积 Top 文件</div>
        <el-table :data="stats.topFilesBySize" row-key="id" size="small">
          <el-table-column prop="originalName" label="文件名" min-width="220" show-overflow-tooltip />
          <el-table-column label="目录" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.folderPath || '/' }}</template>
          </el-table-column>
          <el-table-column prop="category" label="类型" width="100" />
          <el-table-column label="大小" width="120">
            <template #default="{ row }">{{ formatSize(row.size) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div class="section-title">公开访问热点（近 {{ hotspots?.days || 7 }} 日）</div>
          <el-select v-model="hotspotDays" size="small" style="width: 120px" @change="loadHotspots">
            <el-option :value="1" label="近 1 日" />
            <el-option :value="7" label="近 7 日" />
            <el-option :value="30" label="近 30 日" />
          </el-select>
        </div>
        <el-row :gutter="16">
          <el-col :xs="24" :md="12">
            <div class="muted" style="margin-bottom: 8px">按来源域名（Referer）</div>
            <el-table v-loading="hotspotsLoading" :data="hotspots?.byReferer || []" size="small" empty-text="暂无公开访问数据">
              <el-table-column prop="refererHost" label="来源" min-width="160" show-overflow-tooltip />
              <el-table-column prop="hits" label="次数" width="90" />
              <el-table-column label="流量" width="120">
                <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
              </el-table-column>
            </el-table>
          </el-col>
          <el-col :xs="24" :md="12">
            <div class="muted" style="margin-bottom: 8px">按文件</div>
            <el-table v-loading="hotspotsLoading" :data="hotspots?.byFile || []" size="small" empty-text="暂无公开访问数据">
              <el-table-column label="文件" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">{{ row.originalName || row.fileId || '-' }}</template>
              </el-table-column>
              <el-table-column prop="hits" label="次数" width="90" />
              <el-table-column label="流量" width="120">
                <template #default="{ row }">{{ formatSize(row.bytes) }}</template>
              </el-table-column>
            </el-table>
          </el-col>
        </el-row>
      </div>
    </section>

    <section class="metric-grid">
      <div class="metric">
        <div class="metric-label">项目存储</div>
        <div class="storage-tags">
          <el-tag v-for="storage in projectStorages" :key="storage.id" :type="storage.enabled ? 'success' : 'info'" size="small">
            {{ storage.name }} · {{ storage.enabled ? '启用' : '停用' }} · {{ storage.provider === 'LOCAL' ? '本地兜底' : `优先级 ${storage.priority}` }}
          </el-tag>
          <span v-if="!projectStorages.length" class="muted">暂无配置关系</span>
        </div>
        <div class="metric-sub">优先下载：{{ preferredProjectStorage ? `${preferredProjectStorage.name}（${storageProviderLabel(preferredProjectStorage.provider)}）` : '暂无启用存储' }}。云端按优先级依次尝试，本地兜底。</div>
      </div>
      <div class="metric">
        <div class="metric-label">分享链接</div>
        <div class="metric-value">{{ stats?.shareLinkCount || 0 }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">有效密钥</div>
        <div class="metric-value">{{ stats?.activeSecretCount || 0 }}</div>
      </div>
      <div class="metric">
        <div class="metric-label">公开文件域名</div>
        <div class="metric-value small-value">{{ formatDomains(project?.allowedDomains) }}</div>
      </div>
    </section>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div class="section-title">项目密钥</div>
          <el-button type="primary" :icon="Key" @click="createSecret">新增密钥</el-button>
        </div>
        <el-table :data="secrets" row-key="id">
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '有效' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="最近使用" min-width="170">
            <template #default="{ row }">{{ formatTime(row.lastUsedAt) }}</template>
          </el-table-column>
          <el-table-column label="创建时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button v-if="row.enabled" link type="danger" @click="disableSecret(row.id)">停用</el-button>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">使用的存储</div>
            <div class="muted">项目绑定配置；云按全局优先级升序、同值按配置 ID 排序，本地兜底。下载使用已校验且可用的副本。</div>
          </div>
          <el-button :icon="Connection" @click="$router.push('/storage-configs')">
            管理全局存储
          </el-button>
        </div>
        <el-table :data="projectStorages" row-key="id" empty-text="暂无存储配置关系">
          <el-table-column prop="name" label="配置名称" min-width="180" />
          <el-table-column prop="provider" label="平台" width="120" />
          <el-table-column label="状态" width="120">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="下载排序" min-width="150">
            <template #default="{ row }">{{ row.provider === 'LOCAL' ? '本地兜底' : `全局优先级 ${row.priority}` }}</template>
          </el-table-column>
          <el-table-column label="云账户用量" min-width="250">
            <template #default="{ row }">
              <span v-if="row.provider === 'LOCAL'" class="muted">不适用</span>
              <template v-else>
                空间 {{ cloudUsages[row.id]?.storageUsedBytes != null ? formatSize(cloudUsages[row.id]!.storageUsedBytes!) : '未知' }}
                <span class="muted">
                  · 本月流量 {{ cloudUsages[row.id]?.trafficUsedBytes != null ? formatSize(cloudUsages[row.id]!.trafficUsedBytes!) : '未知' }}
                </span>
                <div v-if="cloudUsages[row.id]" class="muted">读取时间 {{ formatTime(cloudUsages[row.id]!.checkedAt) }} · {{ cloudUsages[row.id]!.message || '云账户口径，不是项目副本体积' }}</div>
                <div v-if="cloudUsageErrors[row.id]" class="muted">{{ cloudUsageErrors[row.id] }}</div>
                <el-button link type="primary" :loading="cloudUsageLoading[row.id]" @click="loadCloudUsage(row.id)">读取用量</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section class="surface replica-section">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">存储副本</div>
            <div class="muted">索引记录包含历史版本与派生对象；状态统计覆盖完整项目。当前版本的原文件副本请查看文件详情。</div>
          </div>
          <div class="toolbar">
            <el-button :loading="replicasLoading" @click="loadReplicas()">刷新状态</el-button>
            <template v-if="project?.canManage">
              <el-button :disabled="Boolean(replicaAction)" :loading="replicaAction === 'sync'" @click="runReplicaAction('sync')">{{ replicaCursors.sync ? '继续补同步' : '补同步' }}</el-button>
              <el-button :disabled="Boolean(replicaAction)" :loading="replicaAction === 'inspect'" @click="runReplicaAction('inspect')">{{ replicaCursors.inspect ? '继续巡检' : '巡检' }}</el-button>
              <el-button :disabled="Boolean(replicaAction)" :loading="replicaAction === 'retry'" @click="runReplicaAction('retry')">重试失败</el-button>
            </template>
          </div>
        </div>
        <el-alert v-if="replicasError" :title="replicasError" type="error" :closable="false" />
        <p v-if="replicaResult" class="muted">{{ replicaResult }}</p>
        <div class="toolbar" style="margin-bottom: 12px">
          <el-tag v-for="state in replicaStates" :key="state" :type="replicaStatusType(state)">{{ replicaStatusLabel(state) }} {{ replicas ? (replicas.counts?.[state] || 0) : '未知' }}</el-tag>
        </div>
        <el-table v-loading="replicasLoading" :data="replicas?.items || []" row-key="id" empty-text="暂无副本记录">
          <el-table-column label="存储" min-width="150"><template #default="{ row }">{{ row.configName || row.provider || row.configId }}</template></el-table-column>
          <el-table-column prop="storageKey" label="对象" min-width="220" show-overflow-tooltip />
          <el-table-column label="大小" width="110"><template #default="{ row }">{{ formatSize(Number(row.size)) }}</template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="replicaStatusType(row.status)">{{ replicaStatusLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column prop="attempts" label="尝试次数" width="100" />
          <el-table-column prop="lastError" label="最近失败" min-width="160" show-overflow-tooltip />
          <el-table-column label="最近校验" min-width="170"><template #default="{ row }">{{ formatTime(row.verifiedAt) }}</template></el-table-column>
        </el-table>
        <el-pagination :current-page="replicaPage" :page-size="replicaPageSize" :page-sizes="pageSizes" :total="replicaTotal" layout="total, sizes, prev, pager, next, jumper" class="panel-pagination" :pager-count="5" @update:current-page="changeReplicaPage" @update:page-size="changeReplicaPageSize" />
      </div>
    </section>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">存储迁移</div>
            <div class="muted">把仍挂在源配置上的文件对象迁移到目标配置，任务中心可查看进度。</div>
          </div>
        </div>
        <el-form label-position="top" class="migrate-form">
          <el-form-item label="源存储配置">
            <el-select v-model="migrateForm.sourceCdnConfigId" filterable class="full-input">
              <el-option v-for="item in cdnConfigs" :key="item.id" :label="`${item.name} (${item.provider})`" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="目标存储配置">
            <el-select v-model="migrateForm.targetCdnConfigId" filterable class="full-input">
              <el-option v-for="item in cdnConfigs" :key="item.id" :label="`${item.name} (${item.provider})`" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-checkbox v-model="migrateForm.deleteSource">迁移成功后尝试删除源对象</el-checkbox>
          </el-form-item>
          <el-button type="primary" :loading="migrateLoading" @click="startMigrate">开始迁移</el-button>
        </el-form>
      </div>
    </section>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">生命周期策略</div>
            <div class="muted">按目录/类型对过期文件自动回收或标记清理。</div>
          </div>
          <el-button type="primary" @click="openCreateLifecycle">新建策略</el-button>
        </div>
        <el-table v-loading="lifecycleLoading" :data="lifecyclePolicies" row-key="id">
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column label="目录" min-width="120">
            <template #default="{ row }">{{ row.folderPath || '/' }}</template>
          </el-table-column>
          <el-table-column prop="ttlDays" label="TTL(天)" width="90" />
          <el-table-column prop="action" label="动作" width="100" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160">
            <template #default="{ row }">
              <el-button link type="primary" @click="runLifecycle(row.id)">执行</el-button>
              <el-button link type="danger" @click="removeLifecycle(row.id)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section v-if="project?.canManage" class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div>
            <div class="section-title">上传凭证</div>
            <div class="muted">用于客户端直传（Authorization: Upload &lt;token&gt;）。Token 仅创建时展示一次。</div>
          </div>
          <el-button type="primary" @click="openCreateCredential">新建凭证</el-button>
        </div>
        <el-table v-loading="credentialsLoading" :data="uploadCredentials" row-key="id">
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column prop="tokenPrefix" label="前缀" width="120" />
          <el-table-column label="用量" min-width="160">
            <template #default="{ row }">
              {{ formatSize(row.usedBytes || 0) }}
              <span v-if="row.maxBytes"> / {{ formatSize(row.maxBytes) }}</span>
              · {{ row.usedFiles || 0 }}
              <span v-if="row.maxFiles"> / {{ row.maxFiles }}</span> 个
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="过期" min-width="160">
            <template #default="{ row }">{{ formatTime(row.expiresAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="100">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'ACTIVE'"
                link
                type="danger"
                @click="revokeCredential(row.id)"
              >
                吊销
              </el-button>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section class="surface">
      <div class="surface-body">
        <div class="section-head">
          <div class="section-title">最近文件</div>
          <el-button :loading="filesLoading" @click="loadFiles">刷新</el-button>
        </div>
        <el-alert v-if="filesError" :title="filesError" type="error" :closable="false" />
        <el-table v-loading="filesLoading" :data="files" row-key="id" empty-text="暂无文件">
          <el-table-column prop="originalName" label="文件名" min-width="220" show-overflow-tooltip />
          <el-table-column prop="folderPath" label="目录" min-width="140">
            <template #default="{ row }">{{ row.folderPath || '/' }}</template>
          </el-table-column>
          <el-table-column prop="category" label="类型" width="120" />
          <el-table-column label="大小" width="120">
            <template #default="{ row }">{{ formatSize(row.size) }}</template>
          </el-table-column>
          <el-table-column label="上传时间" min-width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="90">
            <template #default="{ row }"><el-button link type="primary" @click="openFileDetails(row)">详情</el-button></template>
          </el-table-column>
        </el-table>
        <el-pagination :current-page="filesPage" :page-size="filesPageSize" :page-sizes="pageSizes" :total="filesTotal" layout="total, sizes, prev, pager, next, jumper" class="panel-pagination" :pager-count="5" @update:current-page="changeFilesPage" @update:page-size="changeFilesPageSize" />
      </div>
    </section>

    <FileStorageDetails v-model="detailsVisible" :file="detailFile" />

    <el-dialog v-model="secretDialogVisible" title="项目密钥" width="560px">
      <el-alert type="warning" show-icon :closable="false" title="AppSecret 仅展示本次，关闭后无法再次查看。" />
      <div class="secret-box">
        <div>
          <span class="muted">AppID</span>
          <div class="mono">{{ project?.appId }}</div>
        </div>
        <div>
          <span class="muted">AppSecret</span>
          <div class="mono secret-value">{{ latestSecret }}</div>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="credentialTokenVisible" title="上传凭证 Token" width="640px">
      <el-alert type="warning" show-icon :closable="false" title="Token 仅展示本次，请立即复制保存。" />
      <div class="secret-box">
        <div>
          <span class="muted">Token</span>
          <div class="mono secret-value">{{ latestCredentialToken }}</div>
        </div>
      </div>
    </el-dialog>

  </div>
</template>

<script setup lang="ts">
import { Back, Connection, Download, Key, Upload, UploadFilled } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { http } from '@/api/http';
import { cdnApi, downloadStatsApi, fileApi, projectApi, replicaApi, uploadCredentialApi } from '@/api/modules';
import FileStorageDetails from '@/components/FileStorageDetails.vue';
import { storageProviderLabel } from '@/utils/storage-replica-view';
import type {
  CdnConfig,
  DownloadStatsSummary,
  ManagedFile,
  Project,
  ProjectSecret,
  ProjectStats,
  StorageUsageResult,
  StorageReplicaStatus,
  StorageReplicaSummary,
} from '@/types';
import { saveBlob } from '@/utils/io';

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.projectId || ''));
let contextGeneration = 0;
const panelReads = new Map<string, globalThis.AbortController>();

function captureContext() {
  const id = projectId.value;
  const generation = contextGeneration;
  return { id, current: () => generation === contextGeneration && id === projectId.value };
}

async function readPanel<T>(key: string, fetch: (id: string, signal: globalThis.AbortSignal) => Promise<T>, commit: (result: T) => void | Promise<void>, busy?: { value: boolean }, fail?: () => void, matches = () => true): Promise<void> {
  const context = captureContext();
  panelReads.get(key)?.abort();
  const controller = new globalThis.AbortController();
  panelReads.set(key, controller);
  const current = () => context.current() && panelReads.get(key) === controller && !controller.signal.aborted;
  if (busy) busy.value = true;
  try {
    const result = await fetch(context.id, controller.signal);
    if (current() && matches()) await commit(result);
  } catch {
    if (current() && matches()) fail?.();
  } finally {
    if (current() && busy) busy.value = false;
  }
}

const pageSizes = [10, 20, 50, 100];
function validPage(value: number): number { return Number.isSafeInteger(value) && value > 0 ? value : 1; }
function validPageSize(value: number): number { return pageSizes.includes(value) ? value : 20; }

async function readPagedPanel<T extends { total?: number; page?: number }>(
  key: string, pageState: { value: number }, sizeState: { value: number }, totalState: { value: number },
  busy: { value: boolean }, error: { value: string },
  fetch: (id: string, signal: globalThis.AbortSignal, page: number, pageSize: number) => Promise<T>,
  commit: (result: T) => void, message: string, matches = () => true,
): Promise<void> {
  const page = validPage(pageState.value), pageSize = validPageSize(sizeState.value);
  pageState.value = page; sizeState.value = pageSize; error.value = '';
  await readPanel(key, (id, signal) => fetch(id, signal, page, pageSize), async result => {
    const total = Number.isSafeInteger(result.total) && result.total! >= 0 ? result.total! : 0;
    const last = Math.max(1, Math.ceil(total / pageSize));
    totalState.value = total;
    if (page > last && result.page !== last) {
      pageState.value = last;
      await readPagedPanel(key, pageState, sizeState, totalState, busy, error, fetch, commit, message, matches);
      return;
    }
    pageState.value = Math.min(last, validPage(result.page ?? page));
    commit(result);
  }, busy, () => { error.value = message; }, () => pageState.value === page && sizeState.value === pageSize && matches());
}

const replicas = ref<StorageReplicaSummary | null>(null);
const replicasLoading = ref(false);
const replicasError = ref('');
const replicaPage = ref(1);
const replicaPageSize = ref(20);
const replicaTotal = ref(0);
const replicaAction = ref('');
const replicaCursors = reactive<{ sync: string | null; inspect: string | null }>({ sync: null, inspect: null });
const replicaResult = ref('');
const replicaStates: StorageReplicaStatus[] = ['READY', 'PENDING', 'SYNCING', 'FAILED', 'MISSING', 'SKIPPED'];
function replicaStatusLabel(status: StorageReplicaStatus): string {
  return { READY: '已就绪', PENDING: '待同步', SYNCING: '同步中', FAILED: '失败', MISSING: '缺失', SKIPPED: '已解绑' }[status] || status;
}
function replicaStatusType(status: StorageReplicaStatus): 'success' | 'warning' | 'danger' | 'info' {
  return status === 'READY' ? 'success' : status === 'FAILED' || status === 'MISSING' ? 'danger' : status === 'PENDING' || status === 'SYNCING' ? 'warning' : 'info';
}
async function loadReplicas(): Promise<void> {
  await readPagedPanel('replicas', replicaPage, replicaPageSize, replicaTotal, replicasLoading, replicasError,
    (id, signal, page, pageSize) => replicaApi.list(id, { signal, _silent: true }, { page, pageSize }),
    result => { replicas.value = result; }, '副本状态暂不可用，已知记录仍保留，请刷新重试。');
}
async function changeReplicaPage(page: number): Promise<void> { replicaPage.value = validPage(page); await loadReplicas(); }
async function changeReplicaPageSize(size: number): Promise<void> { replicaPageSize.value = validPageSize(size); replicaPage.value = 1; await loadReplicas(); }
async function runReplicaAction(action: 'sync' | 'inspect' | 'retry'): Promise<void> {
  if (!project.value?.canManage || replicaAction.value) return;
  const context = captureContext();
  replicaAction.value = action;
  try {
    const result = await replicaApi.run(context.id, action, action === 'retry' ? {} : { cursor: replicaCursors[action] || undefined, limit: 20 });
    if (!context.current()) return;
    if (action !== 'retry') replicaCursors[action] = result.nextCursor || null;
    replicaResult.value = action === 'inspect'
      ? `本批次巡检 ${result.scanned || 0} 项，就绪 ${result.ready || 0} 项，失败 ${result.failed || 0} 项。`
      : action === 'sync'
        ? `本批次扫描 ${result.scanned || 0} 项，加入同步队列 ${result.queued || 0} 项。`
        : `已将 ${result.queued || 0} 个失败副本加入重试队列。`;
    if (result.nextCursor) replicaResult.value += '仍有后续批次。';
    ElMessage.success(action === 'inspect' ? '本批次巡检已完成。' : '副本同步任务已提交。');
    await loadReplicas();
  } catch { /* Keep status visible and allow another attempt. */ }
  finally { if (context.current()) replicaAction.value = ''; }
}
const project = ref<Project | null>(null);
const projectFolders = ref<Array<{ name: string; path: string; fileCount: number; children: unknown[] }>>([]);
const directoriesLoading = ref(false);
const directoriesError = ref('');

async function loadDirectories(): Promise<void> {
  directoriesError.value = '';
  await readPanel('directories', (id, signal) => fileApi.listFolderTree(id, { signal, _silent: true }), result => {
    projectFolders.value = result;
  }, directoriesLoading, () => { directoriesError.value = '目录加载失败，请刷新重试。'; });
}

function openDirectory(folderPath: string): void {
  void router.push({ path: '/files', query: { projectId: projectId.value, folderPath } });
}

async function createDirectory(parentPath = ''): Promise<void> {
  if (!project.value?.canManage) return;
  const context = captureContext();
  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt(`在 ${parentPath || '根目录'} 下创建目录（可包含多级，如 contracts/2026）`, '新建目录', {
      confirmButtonText: '创建', cancelButtonText: '取消', inputPattern: /^[^\\:*?"<>|]+$/, inputErrorMessage: '目录名不能包含 \\ : * ? " < > |',
    }));
  } catch { return; }
  if (!context.current()) return;
  const name = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!name) { ElMessage.warning('目录名不能为空。'); return; }
  await fileApi.createFolder(context.id, [parentPath, name].filter(Boolean).join('/'));
  if (!context.current()) return;
  ElMessage.success('目录已创建。');
  await loadDirectories();
}

async function removeDirectory(folderPath: string): Promise<void> {
  if (!project.value?.canManage || !folderPath) return;
  const context = captureContext();
  type Node = { path: string; fileCount: number; children: unknown[] };
  const find = (nodes: Node[]): Node | undefined => {
    for (const node of nodes) {
      if (node.path === folderPath) return node;
      const child = find(node.children as Node[]);
      if (child) return child;
    }
    return undefined;
  };
  const node = find(projectFolders.value);
  const hasFiles = (item: Node): boolean => item.fileCount > 0 || (item.children as Node[]).some(hasFiles);
  if (node && hasFiles(node)) { ElMessage.warning('目录中存在文件，请先删除目录及子目录中的文件。'); return; }
  if (node?.children.length) { ElMessage.warning('目录中存在子目录，请先删除子目录。'); return; }
  try {
    await ElMessageBox.confirm(`确认删除目录 ${folderPath}？仅允许删除空目录；有文件时请先删除文件，有子目录时请先删除子目录。回收站文件仍可恢复。`, '删除空目录', {
      type: 'warning', confirmButtonText: '删除目录', cancelButtonText: '取消',
    });
  } catch { return; }
  if (!context.current()) return;
  await fileApi.removeFolder(context.id, folderPath);
  if (!context.current()) return;
  ElMessage.success('空目录已删除。');
  await loadDirectories();
}
const stats = ref<ProjectStats | null>(null);
const projectStorages = computed(() => [...(project.value?.storages || [])].sort((a, b) => Number(a.provider === 'LOCAL') - Number(b.provider === 'LOCAL') || a.priority - b.priority || a.id.localeCompare(b.id)));
const preferredProjectStorage = computed(() => projectStorages.value.find(storage => storage.enabled));
const cloudUsages = ref<Record<string, StorageUsageResult>>({});
const cloudUsageLoading = ref<Record<string, boolean>>({});
const cloudUsageErrors = ref<Record<string, string>>({});
const hotspotsLoading = ref(false);
const hotspotDays = ref(7);
const hotspots = ref<{
  days: number;
  byReferer: Array<{ refererHost: string; hits: number; bytes: number }>;
  byFile: Array<{ fileId: string | null; originalName: string | null; hits: number; bytes: number }>;
} | null>(null);
const cdnConfigs = ref<CdnConfig[]>([]);
const files = ref<ManagedFile[]>([]);
const filesPage = ref(1);
const filesPageSize = ref(20);
const filesTotal = ref(0);
const filesLoading = ref(false);
const filesError = ref('');
const detailFile = ref<ManagedFile | null>(null);
const detailsVisible = ref(false);

function openFileDetails(file: ManagedFile): void {
  if (file.projectId !== projectId.value) return;
  detailFile.value = file; detailsVisible.value = true;
}

async function loadFiles(): Promise<void> {
  await readPagedPanel('files', filesPage, filesPageSize, filesTotal, filesLoading, filesError,
    (id, signal, page, pageSize) => fileApi.list({ projectId: id, status: 'ACTIVE', page, pageSize }, { signal, _silent: true }),
    result => { files.value = result.items; }, '最近文件加载失败，已知记录仍保留，请刷新重试。');
}
async function changeFilesPage(page: number): Promise<void> { filesPage.value = validPage(page); await loadFiles(); }
async function changeFilesPageSize(size: number): Promise<void> { filesPageSize.value = validPageSize(size); filesPage.value = 1; await loadFiles(); }
const secrets = ref<ProjectSecret[]>([]);
const importInputRef = ref<HTMLInputElement>();
const secretDialogVisible = ref(false);
const latestSecret = ref('');
const uploadCredentials = ref<
  Array<{
    id: string;
    name: string;
    tokenPrefix: string;
    maxBytes?: number | null;
    usedBytes: number;
    maxFiles?: number | null;
    usedFiles: number;
    expiresAt: string;
    status: string;
  }>
>([]);
const credentialsLoading = ref(false);
const credentialTokenVisible = ref(false);
const latestCredentialToken = ref('');
const migrateLoading = ref(false);
const migrateForm = reactive({
  sourceCdnConfigId: '',
  targetCdnConfigId: '',
  deleteSource: false,
});
const lifecycleLoading = ref(false);
const lifecyclePolicies = ref<
  Array<{
    id: string;
    name: string;
    folderPath?: string | null;
    ttlDays: number;
    action: string;
    enabled: boolean;
  }>
>([]);

const downloadDays = ref(30);
const downloadLoading = ref(false);
const downloadError = ref('');
const downloadSummaryLoading = ref(false);
const downloadSummaryError = ref('');
const downloadSummary = ref<DownloadStatsSummary | null>(null);
const downloadItems = ref<
  Array<{
    id: string;
    fileId: string | null;
    originalName: string | null;
    bytes: number;
    source: string;
    message: string | null;
    success: boolean;
    ip: string | null;
    createdAt: string;
  }>
>([]);
const downloadTotal = ref(0);
const downloadPage = ref(1);
const downloadPageSize = ref(20);

function sourceLabel(source: string): string {
  return downloadSummary.value?.labels?.[source] || source;
}

async function loadDownloadStats(): Promise<void> {
  const days = downloadDays.value;
  downloadSummaryError.value = '';
  await Promise.all([
    readPanel('download-summary', (id, signal) => downloadStatsApi.summary(id, { days }, { signal, _silent: true }), result => { downloadSummary.value = result; }, downloadSummaryLoading,
      () => { downloadSummaryError.value = '下载摘要加载失败，请重新选择时间范围或刷新。'; }, () => downloadDays.value === days),
    loadDownloadItems(),
  ]);
}
async function loadDownloadItems(): Promise<void> {
  const days = downloadDays.value;
  await readPagedPanel('downloads', downloadPage, downloadPageSize, downloadTotal, downloadLoading, downloadError,
    (id, signal, page, pageSize) => downloadStatsApi.list(id, { days, page, pageSize }, { signal, _silent: true }),
    result => { downloadItems.value = result.items; }, '下载明细加载失败，已知记录仍保留，请重试。', () => downloadDays.value === days);
}
async function changeDownloadPage(page: number): Promise<void> { downloadPage.value = validPage(page); await loadDownloadItems(); }
async function changeDownloadPageSize(size: number): Promise<void> { downloadPageSize.value = validPageSize(size); downloadPage.value = 1; await loadDownloadItems(); }
async function changeDownloadDays(): Promise<void> {
  downloadPage.value = 1; downloadItems.value = []; downloadTotal.value = 0; downloadSummary.value = null;
  await loadDownloadStats();
}
function formatTime(value?: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}

function formatSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function trendHeight(count: number): number {
  const max = Math.max(...(stats.value?.uploadTrend?.map((item) => item.count) || [1]), 1);
  return Math.max(6, Math.round((count / max) * 100));
}

function formatDomains(value: string[] | undefined): string {
  return value && value.length > 0 ? value.join('、') : '使用全局白名单';
}

async function loadDetail(): Promise<void> {
  await Promise.all([
    readPanel('project', (id, signal) => projectApi.get(id, { signal }), result => {
      project.value = result;
      if (result.canManage) {
        void loadDirectories();
        void readPanel('secrets', (id, signal) => projectApi.listSecrets(id, { signal }), result => { secrets.value = result; });
        void loadCredentials();
        void loadLifecycle();
      }
    }),
    readPanel('stats', (id, signal) => projectApi.stats(id, { signal }), result => { stats.value = result; }),
    readPanel('storage', (id, signal) => cdnApi.list(id, { signal }), result => {
      cdnConfigs.value = result.filter(config => config.enabled);
      if (!migrateForm.sourceCdnConfigId) migrateForm.sourceCdnConfigId = cdnConfigs.value[0]?.id || '';
      if (!migrateForm.targetCdnConfigId) migrateForm.targetCdnConfigId = cdnConfigs.value[1]?.id || '';
    }),
    loadFiles(),
    loadHotspots(),
    loadDownloadStats(),
    loadReplicas(),
  ]);
}

async function loadCloudUsage(configId: string): Promise<void> {
  if (!projectStorages.value.some(storage => storage.id === configId && storage.provider !== 'LOCAL')) return;
  const busy = { get value() { return cloudUsageLoading.value[configId] || false; }, set value(value: boolean) { cloudUsageLoading.value[configId] = value; } };
  cloudUsageErrors.value[configId] = '';
  await readPanel(`usage:${configId}`, (id, signal) => cdnApi.usage(configId, id, { signal, _silent: true }), result => {
    if (result.configId === configId) cloudUsages.value[configId] = result;
  }, busy, () => { cloudUsageErrors.value[configId] = '用量读取失败；未知用量保持未知。'; });
}

async function loadHotspots(): Promise<void> {
  const days = hotspotDays.value;
  await readPanel('hotspots', (id, signal) => projectApi.hotspots(id, { days, limit: 15 }, { signal }), result => { hotspots.value = result; }, hotspotsLoading);
}

async function loadLifecycle(): Promise<void> {
  await readPanel('lifecycle', (id, signal) => http.get<unknown, typeof lifecyclePolicies.value>(`/projects/${id}/lifecycle-policies`, { signal }), result => { lifecyclePolicies.value = result; }, lifecycleLoading);
}

async function openCreateLifecycle(): Promise<void> {
  const context = captureContext();
  const { value: name } = await ElMessageBox.prompt('策略名称', '新建生命周期策略', {
    confirmButtonText: '下一步',
    cancelButtonText: '取消',
    inputValue: '默认 90 天回收',
  });
  if (!context.current()) return;
  const { value: ttlText } = await ElMessageBox.prompt('TTL 天数', '新建生命周期策略', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputValue: '90',
    inputPattern: /^[1-9]\d*$/,
    inputErrorMessage: '请输入正整数天数',
  });
  if (!context.current()) return;
  await http.post(`/projects/${context.id}/lifecycle-policies`, {
    name,
    ttlDays: Number(ttlText),
    action: 'RECYCLE',
    enabled: true,
  });
  if (!context.current()) return;
  ElMessage.success('策略已创建。');
  await loadLifecycle();
}

async function runLifecycle(policyId: string): Promise<void> {
  const context = captureContext();
  const result = (await http.post(`/projects/${context.id}/lifecycle-policies/${policyId}/run`)) as {
    affected?: number;
  };
  if (!context.current()) return;
  ElMessage.success(`已处理 ${result.affected ?? 0} 个文件。`);
}

async function removeLifecycle(policyId: string): Promise<void> {
  const context = captureContext();
  await ElMessageBox.confirm('删除该生命周期策略？', '删除策略', { type: 'warning' });
  if (!context.current()) return;
  await http.delete(`/projects/${context.id}/lifecycle-policies/${policyId}`);
  if (!context.current()) return;
  ElMessage.success('已删除。');
  await loadLifecycle();
}

async function startMigrate(): Promise<void> {
  const context = captureContext();
  const payload = { ...migrateForm };
  if (!migrateForm.sourceCdnConfigId || !migrateForm.targetCdnConfigId) {
    ElMessage.warning('请选择源与目标存储配置。');
    return;
  }
  await ElMessageBox.confirm('迁移会在后台任务中执行，请到任务中心查看进度。', '存储迁移', {
    type: 'warning',
    confirmButtonText: '开始',
    cancelButtonText: '取消',
  });
  if (!context.current()) return;
  migrateLoading.value = true;
  try {
    const result = (await http.post(`/projects/${context.id}/storage/migrate`, payload)) as { taskId?: string };
    if (!context.current()) return;
    ElMessage.success(result.taskId ? `迁移任务已创建：${result.taskId}` : '迁移任务已创建。');
  } finally {
    if (context.current()) migrateLoading.value = false;
  }
}

async function loadCredentials(): Promise<void> {
  await readPanel('credentials', (id, signal) => uploadCredentialApi.list(id, { signal }), result => { uploadCredentials.value = result; }, credentialsLoading);
}

async function openCreateCredential(): Promise<void> {
  const context = captureContext();
  const { value } = await ElMessageBox.prompt('凭证名称', '新建上传凭证', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputValue: '客户端直传',
    inputPattern: /^.{1,128}$/,
    inputErrorMessage: '名称不能为空。',
  });
  if (!context.current()) return;
  const result = await uploadCredentialApi.create(context.id, {
    name: value,
    expiresInSeconds: 7 * 24 * 60 * 60,
  });
  if (!context.current()) return;
  latestCredentialToken.value = result.token;
  credentialTokenVisible.value = true;
  ElMessage.success('上传凭证已创建。');
  await loadCredentials();
}

async function revokeCredential(credentialId: string): Promise<void> {
  const context = captureContext();
  await ElMessageBox.confirm('吊销后使用该 Token 的客户端将无法继续上传。', '吊销凭证', {
    type: 'warning',
    confirmButtonText: '吊销',
    cancelButtonText: '取消',
  });
  if (!context.current()) return;
  await uploadCredentialApi.revoke(context.id, credentialId);
  if (!context.current()) return;
  ElMessage.success('凭证已吊销。');
  await loadCredentials();
}

async function exportProject(): Promise<void> {
  const context = captureContext();
  const name = project.value?.name || 'project';
  await ElMessageBox.confirm('导出内容只包含项目元数据和文件记录，不包含对象存储中的真实文件内容。', '导出项目', {
    type: 'warning',
    confirmButtonText: '继续导出',
    cancelButtonText: '取消',
  });
  if (!context.current()) return;
  const payload = await projectApi.export(context.id);
  const blob = new globalThis.Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  saveBlob(blob, `${name}-export.json`);
}

async function importProject(event: Event): Promise<void> {
  const context = captureContext();
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';

  if (!file) {
    return;
  }

  await ElMessageBox.confirm('导入只恢复项目和文件记录，不会复制对象存储中的真实文件内容。', '导入项目', {
    type: 'warning',
    confirmButtonText: '继续导入',
    cancelButtonText: '取消',
  });
  if (!context.current()) return;
  const payload = JSON.parse(await file.text()) as Record<string, unknown>;
  const result = await projectApi.import(payload);
  if (!context.current()) return;
  latestSecret.value = result.appSecret;
  secretDialogVisible.value = true;
  ElMessage.success(`项目已导入，文件记录 ${result.fileRecordsImported} 条。`);
  void router.push(`/projects/${result.id}`);
}

async function createSecret(): Promise<void> {
  const context = captureContext();
  const { value } = await ElMessageBox.prompt('密钥名称', '新增项目密钥', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputValue: '个人脚本',
    inputPattern: /^.{2,128}$/,
    inputErrorMessage: '名称长度需要在 2 到 128 个字符之间。',
  });
  if (!context.current()) return;
  const result = await projectApi.createSecret(context.id, { name: value });
  if (!context.current()) return;
  latestSecret.value = result.appSecret;
  secretDialogVisible.value = true;
  await loadDetail();
}

async function disableSecret(secretId: string): Promise<void> {
  const context = captureContext();
  await ElMessageBox.confirm('停用后使用该 AppSecret 的脚本会立即签名失败。', '停用密钥', {
    type: 'warning',
    confirmButtonText: '停用',
    cancelButtonText: '取消',
  });
  if (!context.current()) return;
  await projectApi.disableSecret(context.id, secretId);
  if (!context.current()) return;
  ElMessage.success('项目密钥已停用。');
  await loadDetail();
}

watch(projectId, () => {
  contextGeneration++;
  panelReads.forEach(controller => controller.abort());
  panelReads.clear();
  project.value = null;
  projectFolders.value = [];
  directoriesLoading.value = false;
  directoriesError.value = '';
  stats.value = null;
  cdnConfigs.value = [];
  files.value = [];
  filesPage.value = 1;
  filesPageSize.value = 20;
  filesTotal.value = 0;
  filesLoading.value = false;
  filesError.value = '';
  detailFile.value = null;
  detailsVisible.value = false;
  secrets.value = [];
  cloudUsages.value = {};
  cloudUsageLoading.value = {};
  cloudUsageErrors.value = {};
  hotspots.value = null;
  downloadSummary.value = null;
  downloadItems.value = [];
  downloadTotal.value = 0;
  downloadPage.value = 1;
  downloadPageSize.value = 20;
  downloadLoading.value = false;
  downloadError.value = '';
  downloadSummaryLoading.value = false;
  downloadSummaryError.value = '';
  uploadCredentials.value = [];
  lifecyclePolicies.value = [];
  replicas.value = null;
  replicaPage.value = 1;
  replicaPageSize.value = 20;
  replicaTotal.value = 0;
  replicasLoading.value = false;
  replicasError.value = '';
  replicaAction.value = '';
  replicaCursors.sync = null;
  replicaCursors.inspect = null;
  replicaResult.value = '';
  migrateLoading.value = false;
  migrateForm.sourceCdnConfigId = '';
  migrateForm.targetCdnConfigId = '';
  migrateForm.deleteSource = false;
  secretDialogVisible.value = false;
  latestSecret.value = '';
  credentialTokenVisible.value = false;
  latestCredentialToken.value = '';
  ElMessageBox.close();
  void loadDetail();
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => {
  contextGeneration++;
  panelReads.forEach(controller => controller.abort());
  panelReads.clear();
  ElMessageBox.close();
});
</script>

<style scoped>
.directory-node {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex: 1;
  min-width: 0;
}

.hidden-input {
  display: none;
}

.storage-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.storage-tags :deep(.el-tag) { height: auto; white-space: normal; line-height: 1.6; }
.panel-pagination { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.panel-pagination :deep(.el-pagination__sizes), .panel-pagination :deep(.el-pagination__jump) { margin-left: 0; }
@media (max-width: 600px) { .section-head { align-items: flex-start; flex-wrap: wrap; } .section-head > .toolbar { flex-wrap: wrap; } }

.small-value {
  font-size: 17px;
  overflow-wrap: anywhere;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.section-title {
  font-weight: 700;
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

.full-input {
  width: 100%;
}

.metric-sub {
  margin-top: 6px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.4;
}

.trend-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 120px;
  overflow-x: auto;
  padding-top: 8px;
}

.trend-bar {
  display: flex;
  flex: 0 0 18px;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  gap: 4px;
}

.trend-fill {
  width: 12px;
  border-radius: 4px 4px 0 0;
  background: var(--el-color-primary);
  min-height: 4px;
}

.trend-label {
  font-size: 10px;
  color: #94a3b8;
  writing-mode: horizontal-tb;
  transform: scale(0.9);
}
</style>
