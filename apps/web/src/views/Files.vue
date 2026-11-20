<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ pageTitle }}</h1>
        <p class="page-subtitle">{{ pageSubtitle }}</p>
      </div>
      <div class="toolbar">
        <input
          ref="fileInputRef"
          type="file"
          multiple
          class="hidden-input"
          @change="handleFileChange"
        />
        <input
          ref="replaceFileInputRef"
          type="file"
          class="hidden-input"
          @change="handleReplaceFileChange"
        />
        <input
          ref="folderInputRef"
          type="file"
          multiple
          webkitdirectory
          directory
          class="hidden-input"
          @change="handleFileChange"
        />
        <el-button
          v-if="!isRecycleBin && canManageSelectedProject"
          type="primary"
          :icon="Upload"
          :disabled="!selectedProjectId || uploading"
          @click="fileInputRef?.click()"
        >
          上传文件
        </el-button>
        <el-button
          v-if="!isRecycleBin && canManageSelectedProject"
          :icon="Upload"
          :disabled="!selectedProjectId || uploading"
          @click="folderInputRef?.click()"
        >
          上传文件夹
        </el-button>
        <el-button
          v-if="!isRecycleBin && canManageSelectedProject"
          :icon="FolderAdd"
          :disabled="!selectedProjectId"
          @click="createFolder('')"
        >
          新建根目录
        </el-button>
        <el-dropdown
          v-if="!isRecycleBin && canManageSelectedProject"
          trigger="click"
          @command="router.push('/projects/' + selectedProjectId)"
        >
          <el-button :icon="MoreFilled" :disabled="!selectedProjectId" aria-label="更多项目操作" />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="sync">项目副本补同步</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button v-if="isRecycleBin" :icon="Back" @click="goFiles">返回文件管理</el-button>
      </div>
    </div>

    <section class="surface surface-body file-search" aria-label="文件筛选">
      <div class="toolbar filters">
        <el-select
          v-model="selectedProjectId"
          filterable
          clearable
          placeholder="全部项目"
          aria-label="选择项目"
          class="filter-project"
          @change="handleProjectFilterChange"
        >
          <el-option label="全部项目" value="" />
          <el-option
            v-for="project in projects"
            :key="project.id"
            :label="project.name"
            :value="project.id"
          />
        </el-select>
        <el-input
          v-model="filters.keyword"
          clearable
          placeholder="文件名、备注、标签"
          aria-label="搜索文件名、备注或标签"
          class="filter-keyword"
          :prefix-icon="Search"
          @keyup.enter="reloadFirstPage"
          @clear="reloadFirstPage"
        />
        <el-button class="file-search-button" @click="reloadFirstPage">搜索</el-button>
        <el-button class="file-refresh-button" :icon="Refresh" aria-label="刷新" title="刷新" @click="reload" />
      </div>

      <el-collapse class="advanced-filters">
        <el-collapse-item title="高级过滤" name="advanced">
          <div class="toolbar">
            <el-input
              v-model="filters.tag"
              clearable
              placeholder="标签" aria-label="按标签筛选"
              class="filter-tag"
              @keyup.enter="reloadFirstPage"
            />
            <el-input
              v-model="filters.extension"
              clearable
              placeholder="扩展名" aria-label="按扩展名筛选"
              class="filter-ext"
              @keyup.enter="reloadFirstPage"
            />
            <el-select
              v-model="filters.category"
              clearable
              placeholder="类型" aria-label="按文件类型筛选"
              class="filter-select"
              @change="reloadFirstPage"
            >
              <el-option
                v-for="item in categoryOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
            <el-select
              v-model="filters.cdnProvider"
              clearable
              placeholder="存储" aria-label="按存储筛选"
              class="filter-select"
              @change="reloadFirstPage"
            >
              <el-option
                v-for="provider in storageProviderOptions"
                :key="provider"
                :label="provider === 'LOCAL' ? '本地' : provider"
                :value="provider"
              />
            </el-select>
            <el-checkbox v-model="filters.duplicateOnly" @change="reloadFirstPage">重复文件</el-checkbox>

            <el-input-number
              v-model="filters.minSizeMb"
              :min="0"
              :precision="1"
              controls-position="right"
              placeholder="最小 MB" aria-label="最小文件大小，MB"
              class="size-input"
            />
            <el-input-number
              v-model="filters.maxSizeMb"
              :min="0"
              :precision="1"
              controls-position="right"
              placeholder="最大 MB" aria-label="最大文件大小，MB"
              class="size-input"
            />
            <el-date-picker
              v-model="filters.dateRange"
              type="daterange"
              unlink-panels
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="YYYY-MM-DD"
            />
          </div>
        </el-collapse-item>
      </el-collapse>
    </section>

    <section class="surface">
      <div class="surface-body files-layout" :class="{ 'has-folder': showFolderPane }">
        <aside v-if="showFolderPane" class="folder-pane">
          <div class="folder-pane-head">
            <el-button
              class="folder-toggle"
              text
              :aria-expanded="folderPaneOpen"
              aria-controls="folder-directory"
              @click="folderPaneOpen = !folderPaneOpen"
            >
              <el-icon><FolderOpened /></el-icon>项目目录<el-icon
                :class="{ expanded: folderPaneOpen }"
                ><ArrowDown /></el-icon>
            </el-button>
            <span class="folder-pane-title">项目目录</span>
          </div>
          <div id="folder-directory" :class="['folder-directory', { 'is-open': folderPaneOpen }]">
            <el-alert v-if="foldersError" title="目录加载失败" type="error" :closable="false">
              <el-button link type="primary" @click="reload">重新加载目录</el-button>
            </el-alert>
            <el-tree
              v-loading="foldersLoading"
              :data="folderTree"
              node-key="path"
              :props="{ label: 'name', children: 'children' }"
              highlight-current
              :expand-on-click-node="false"
              :current-node-key="filters.folderPath || ''"
              @node-click="onFolderNodeClick"
            >
              <template #default="{ data }">
                <span class="folder-node">
                  <span>{{ data.name }}</span>
                  <el-tag
                    v-if="isFolderPublic(data.path)"
                    size="small"
                    type="success"
                    effect="plain"
                    >公开</el-tag>
                  <span class="folder-count">{{ data.fileCount }}</span>
                  <el-dropdown
                    v-if="canManageSelectedProject"
                    trigger="click"
                    @command="(cmd: string) => handleFolderCommand(cmd, data.path)"
                  >
                    <el-button
                      link
                      type="primary"
                      size="small"
                      :aria-label="data.name + '目录操作'"
                      @click.stop
                      >⋯</el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item command="create-child">新建子目录</el-dropdown-item>
                        <el-dropdown-item command="delete-folder">删除空目录</el-dropdown-item>
                        <el-dropdown-item command="public-on">设为公开（继承）</el-dropdown-item>
                        <el-dropdown-item command="public-off">取消公开策略</el-dropdown-item>
                        <el-dropdown-item command="batch-public">批量公开现有文件</el-dropdown-item>
                        <el-dropdown-item command="batch-private">批量取消文件公开</el-dropdown-item>
                        <el-dropdown-item command="folder-share">分享目录</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </span>
              </template>
            </el-tree>
            <p v-if="canManageSelectedProject" class="muted folder-hint">
              目录非空时，请先清理文件和子目录。
            </p>
          </div>
        </aside>

        <div ref="filesMain" class="files-main">
          <div v-if="showFolderPane" class="breadcrumb-row">
            <el-breadcrumb separator="/" aria-label="当前目录">
              <el-breadcrumb-item>
                <el-button v-if="folderBreadcrumbs.length" link type="primary" @click="selectFolder('')">根目录</el-button>
                <span v-else>根目录</span>
              </el-breadcrumb-item>
              <el-breadcrumb-item v-for="(seg, index) in folderBreadcrumbs" :key="seg.path">
                <el-button v-if="index < folderBreadcrumbs.length - 1" link type="primary" @click="selectFolder(seg.path)">{{ seg.name }}</el-button>
                <span v-else aria-current="location">{{ seg.name }}</span>
              </el-breadcrumb-item>
            </el-breadcrumb>
          </div>

          <button
            v-if="!isRecycleBin && canManageSelectedProject"
            type="button"
            :disabled="!selectedProjectId || uploading"
            class="drop-zone"
            :class="{ 'is-dragging': isDragging }"
            @dragenter.prevent="handleDragEnter"
            @dragover.prevent="handleDragOver"
            @dragleave.prevent="handleDragLeave"
            @drop.prevent="handleDrop"
            @click="selectedProjectId && !uploading && fileInputRef?.click()"
          >
            <el-icon class="drop-icon" aria-hidden="true"><Upload /></el-icon>
            <span class="drop-copy">
              <span class="drop-title">拖拽文件到此处上传</span>
              <span class="drop-subtitle">也可点击选择多个文件</span>
            </span>
          </button>
          <el-collapse v-if="!isRecycleBin && canManageSelectedProject" class="upload-settings">
            <el-collapse-item title="上传设置" name="upload-settings">
              <div class="upload-options">
                <el-select
                  v-model="uploadStrategy"
                  class="upload-strategy"
                  aria-label="重复文件处理方式"
                >
                  <el-option label="禁止重复（默认，内容相同则拒绝）" value="reject" />
                  <el-option label="同名覆盖（保持直链/分享）" value="replace" />
                  <el-option label="秒传复用（内容相同则复用已有）" value="reuse" />
                </el-select>
                <el-select
                  v-if="uploadStrategy === 'replace'"
                  v-model="replaceTargetFileId"
                  clearable
                  filterable
                  remote
                  reserve-keyword
                  :remote-method="searchReplaceTargets"
                  :loading="replaceTargetLoading"
                  placeholder="可选：搜索并指定要覆盖的目标文件"
                  class="upload-replace-target"
                >
                  <el-option
                    v-for="file in replaceTargetOptions"
                    :key="file.id"
                    :label="`${file.originalName}（${file.folderPath || '/'}）`"
                    :value="file.id"
                  />
                </el-select>
                <el-button
                  v-if="uploadStrategy === 'replace'"
                  type="primary"
                  plain
                  :disabled="uploading"
                  @click="triggerReplaceUpload"
                >
                  选择文件覆盖
                </el-button>
                <span class="upload-hint">
                  {{
                    replaceTargetFileId
                      ? '覆盖指定文件并更新文件名，保留原有直链和分享。'
                      : uploadStrategy === 'replace'
                        ? '覆盖当前目录中的同名文件，保留原有直链和分享。'
                        : uploadStrategy === 'reuse'
                          ? '内容相同则直接返回已有文件'
                          : '内容重复时拒绝上传'
                  }}
                </span>
              </div>
            </el-collapse-item>
          </el-collapse>

          <div v-if="uploading" class="upload-controls">
            <div class="toolbar">
              <span>上传项目：{{ uploadQueueState.projectName || uploadQueueState.projectId }}</span>
              <el-tag v-if="uploadQueueState.paused" type="warning">上传已暂停</el-tag>
              <el-button v-if="!uploadQueueState.paused" @click="pauseUploadQueue()">暂停上传</el-button>
              <el-button v-else type="primary" @click="resumeUploadQueue">继续上传</el-button>
              <el-button @click="cancelUploadQueue">取消上传</el-button>
              <span class="muted">暂停或取消在当前请求完成后生效；页面内切换可继续上传。</span>
            </div>
            <el-alert
              v-if="uploadQueueState.error"
              :title="uploadQueueState.error"
              type="warning"
              :closable="false"
              style="margin-top: 8px"
            />
            <el-progress :percentage="uploadProgress" class="upload-progress" />
          </div>

          <section v-if="uploadResults.files.length" class="upload-results">
            <div class="toolbar">
              <strong>本次上传结果</strong><span class="muted">{{ uploadResults.projectName || uploadResults.projectId }} · 已提交或复用
                {{ uploadResults.files.length }} 个文件</span><el-button
                size="small"
                :loading="uploadResultsLoading"
                @click="loadUploadResultStorage"
                >刷新副本</el-button>
            </div>
            <p class="muted">
              上传提交或已有文件复用已完成；本地保存结果以实际副本校验状态为准，选中的云存储在后台同步。点击详情可查看每个存储的状态。
            </p>
            <el-table :data="visibleUploadResults" row-key="id" size="small">
              <el-table-column
                prop="originalName"
                label="文件名"
                min-width="180"
                show-overflow-tooltip
              />
              <el-table-column label="本地保存" min-width="145"><template #default="{ row }">{{
                  localReplicaResult(storageLocations(row))
                }}</template></el-table-column>
              <el-table-column label="存储状态" min-width="300"><template #default="{ row }"><StorageLocationTags
                    :locations="storageLocations(row)"
                    :error="uploadResultsError"
                    @open="openStorageDetails(row)"
/></template></el-table-column>
              <el-table-column label="操作" width="95"><template #default="{ row }"><el-button link type="primary" @click="openStorageDetails(row)">详情</el-button></template></el-table-column>
            </el-table>
            <el-pagination
              v-model:current-page="uploadResultPage"
              :page-size="20"
              :total="uploadResults.files.length"
              layout="total, prev, pager, next"
              @current-change="loadUploadResultStorage"
            />
          </section>

          <section v-if="downloadResults.length" class="upload-results download-results">
            <div class="toolbar">
              <strong>本次页面下载记录</strong><span class="muted">云存储按优先级依次尝试，失败或无可用云副本时使用本地。</span>
            </div>
            <el-table :data="downloadResults" size="small">
              <el-table-column prop="name" label="文件名" min-width="180" show-overflow-tooltip />
              <el-table-column label="实际下载平台／切换详情" min-width="340"><template #default="{ row }"><DownloadStorageInfo :source="row.source" /></template></el-table-column>
              <el-table-column prop="time" label="时间" width="180" />
            </el-table>
          </section>

          <div class="file-list-heading">
            <div>
              <h2>{{ isRecycleBin ? '已删除文件' : '文件列表' }}</h2>
              <span role="status">共 {{ pageResult.total }} 个文件<span v-if="selectedRows.length">
                  · 已选择 {{ selectedRows.length }} 项</span></span>
            </div>
            <el-button
              v-if="selectedRows.length"
              link
              type="primary"
              @click="fileTable?.clearSelection()"
              >取消选择</el-button>
          </div>
          <div
            v-if="selectedRows.length"
            class="toolbar file-bulk-actions"
            aria-label="所选文件操作"
          >
            <el-button v-if="!isRecycleBin" :icon="Download" @click="batchDownload">
              批量下载
            </el-button>
            <el-button
              v-if="!isRecycleBin"
              type="danger"
              :icon="Delete"
              :disabled="!canManageSelectedRows"
              @click="batchRecycle"
            >
              批量删除
            </el-button>
            <el-button
              v-if="!isRecycleBin"
              :disabled="!canManageSelectedRows"
              @click="openBatchMoveDialog"
            >
              批量移动
            </el-button>
            <el-button
              v-if="!isRecycleBin"
              :disabled="!canManageSelectedRows"
              @click="openBatchCopyDialog"
            >
              批量复制
            </el-button>
            <el-button
              v-if="isRecycleBin"
              :icon="Back"
              :disabled="!canManageSelectedRows"
              @click="batchRestore"
            >
              批量恢复
            </el-button>
            <el-button
              v-if="isRecycleBin"
              type="danger"
              :icon="Delete"
              :disabled="!canManageSelectedRows"
              @click="batchPurge"
            >
              批量彻底删除
            </el-button>
          </div>
          <el-alert v-if="filesError" class="files-error" type="error" :closable="false" show-icon>
            <template #title>文件加载失败，请重试。</template>
            <el-button link type="primary" @click="reload">重新加载文件</el-button>
          </el-alert>
          <p v-if="!pinFileActions && pageResult.items.length" class="table-scroll-hint">
            横向滚动可查看其他列和文件操作
          </p>

          <el-table
            ref="fileTable"
            v-loading="loading"
            :data="pageResult.items"
            row-key="id"
            class="data-table"
            :aria-busy="loading"
            :scrollbar-always-on="!pinFileActions"
            :scrollbar-tabindex="pinFileActions ? undefined : 0"
            :empty-text="
              filesError
                ? '文件加载失败'
                : loading
                  ? '正在加载文件…'
                  : filters.keyword
                    ? '没有找到匹配的文件'
                    : isRecycleBin
                      ? '回收站为空'
                      : '暂无文件，请选择项目后上传'
            "
            @selection-change="handleSelectionChange"
          >
            <el-table-column type="selection" width="48" />
            <el-table-column
              prop="originalName"
              label="文件名"
              min-width="300"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                <div class="file-name">
                  <img
                    v-if="row.thumbnailUrl"
                    :src="fileAccessSource(row.thumbnailUrl)"
                    :alt="row.originalName"
                    class="thumb"
                    @error="handleThumbError(row)"
                  />
                  <el-icon v-else><Document /></el-icon>
                  <div class="file-main">
                    <div class="file-title">
                      <span>{{ row.originalName }}</span>
                      <el-tag v-if="row.isPublic" type="success" size="small">公开</el-tag>
                      <el-tag v-if="row.duplicate" type="warning" size="small">重复</el-tag>
                    </div>
                    <div class="file-meta">
                      <span>{{ row.folderPath || '/' }}</span>
                      <span v-if="row.remark">{{ row.remark }}</span>
                    </div>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              v-if="!selectedProjectId"
              label="项目"
              min-width="150"
              show-overflow-tooltip
            >
              <template #default="{ row }">
                {{ row.projectName || row.projectId }}
              </template>
            </el-table-column>
            <el-table-column label="标签" min-width="160">
              <template #default="{ row }">
                <div class="tag-line">
                  <el-tag v-for="tag in row.tags" :key="tag" size="small" effect="plain">{{
                    tag
                  }}</el-tag>
                  <span v-if="row.tags.length === 0" class="muted">-</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="category" label="类型" width="110">
              <template #default="{ row }">
                <el-tag>{{ categoryLabel(row.category) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="大小" width="120">
              <template #default="{ row }">{{ formatSize(row.size) }}</template>
            </el-table-column>
            <el-table-column v-if="!isRecycleBin" label="版本" width="80">
              <template #default="{ row }">v{{ row.currentVersion || 1 }}</template>
            </el-table-column>
            <el-table-column v-if="isRecycleBin" label="清理方式" width="160">
              <template #default>确认彻底删除后清理</template>
            </el-table-column>
            <el-table-column label="存储位置" min-width="280">
              <template #default="{ row }">
                <StorageLocationTags
                  :locations="storageLocations(row)"
                  :error="storageSummaryError"
                  @open="openStorageDetails(row)"
                />
              </template>
            </el-table-column>
            <el-table-column :label="isRecycleBin ? '删除时间' : '上传时间'" min-width="170">
              <template #default="{ row }">
                {{ formatTime(isRecycleBin ? row.deletedAt || row.updatedAt : row.createdAt) }}
              </template>
            </el-table-column>
            <el-table-column label="操作" :fixed="pinFileActions ? 'right' : false" width="300">
              <template #default="{ row }">
                <div class="table-actions">
                  <template v-if="!isRecycleBin">
                    <el-button
                      link
                      type="primary"
                      :disabled="!row.previewable"
                      @click="openPreview(row)"
                      >预览</el-button>
                    <el-button
                      link
                      type="primary"
                      :loading="downloadingIds.has(row.id)"
                      @click="download(row)"
                    >
                      下载
                    </el-button>
                    <el-button link type="primary" @click="openStorageDetails(row)">详情</el-button>
                    <el-button
                      v-if="canManageFile(row)"
                      link
                      type="primary"
                      @click="openEditDialog(row)"
                    >
                      编辑
                    </el-button>
                    <el-button
                      v-if="canManageFile(row) && row.textEditable"
                      link
                      type="primary"
                      @click="contentFile = row"
                      >编辑内容</el-button>
                    <el-button
                      v-if="canManageFile(row)"
                      link
                      type="primary"
                      @click="openShareDialog(row)"
                    >
                      分享
                    </el-button>
                    <el-dropdown
                      v-if="canManageFile(row)"
                      trigger="click"
                      @command="(cmd: string) => handleFileCommand(cmd, row)"
                    >
                      <el-button link type="primary">更多</el-button>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item command="public">
                            {{ row.isPublic ? '取消公开' : '公开（允许未授权域名）' }}
                          </el-dropdown-item>
                          <el-dropdown-item command="public-url">
                            {{ row.isPublic ? '复制公开直链' : '复制直链' }}
                          </el-dropdown-item>
                          <el-dropdown-item v-if="row.status === 'ACTIVE'" command="versions">
                            版本历史
                          </el-dropdown-item>
                          <el-dropdown-item command="replace">上传覆盖（直链不变）</el-dropdown-item>
                          <el-dropdown-item command="move">移动</el-dropdown-item>
                          <el-dropdown-item command="copy">复制</el-dropdown-item>
                          <el-dropdown-item command="delete" divided>
                            <span class="danger">删除</span>
                          </el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </template>
                  <template v-else-if="canManageFile(row)">
                    <template v-if="row.status === 'RECYCLED'">
                      <el-button link type="primary" @click="restore(row)">恢复</el-button>
                      <el-button link type="danger" @click="purge(row)">彻底删除</el-button>
                    </template>
                  </template>
                </div>
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
      </div>
    </section>

    <FileStorageDetails v-model="storageDetailsVisible" :file="storageDetailsFile" @changed="acceptStorageDetails" />

    <el-dialog v-model="editDialogVisible" title="文件信息" width="560px">
      <el-form label-position="top">
        <el-form-item label="文件名">
          <el-input v-model="editForm.originalName" maxlength="255" show-word-limit />
        </el-form-item>
        <el-form-item label="目录">
          <el-input v-model="editForm.folderPath" placeholder="contracts/2026" />
        </el-form-item>
        <el-form-item label="标签">
          <el-input v-model="editForm.tags" placeholder="合同,发票,归档" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editForm.remark" type="textarea" :rows="3" maxlength="512" show-word-limit />
        </el-form-item>
        <el-form-item label="公开访问">
          <el-switch v-model="editForm.isPublic" active-text="公开" inactive-text="私有" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="editing" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="shareDialogVisible"
      :title="editingShareId ? '编辑分享' : '创建分享'"
      width="760px"
      align-center
      destroy-on-close
      append-to-body
      class="share-dialog"
    >
      <div class="share-panel">
        <div v-if="shareFile" class="share-file-banner">
          <div class="share-file-name">{{ shareFile.originalName }}</div>
          <div class="muted">为当前文件创建或管理分享链接</div>
        </div>

        <el-form :model="shareForm" label-position="top" class="share-form-layout">
          <div class="share-form-section">
            <div class="share-form-section-title">基础设置</div>
            <div class="share-form-grid">
              <el-form-item label="访问密码">
                <el-switch v-model="shareForm.requiresPassword" active-text="需要密码" inactive-text="无需密码" />
                <el-input
                  v-if="shareForm.requiresPassword"
                  v-model="shareForm.password"
                  type="password"
                  show-password
                  autocomplete="off"
                  :placeholder="editingShareId ? '留空则保持原密码' : '至少 8 位'"
                  class="share-form-input"
                />
              </el-form-item>
              <el-form-item label="过期时间">
                <el-date-picker
                  v-model="shareForm.expiresAt"
                  type="datetime"
                  value-format="YYYY-MM-DDTHH:mm:ss[Z]"
                  placeholder="不限制"
                  class="share-form-input"
                />
              </el-form-item>
              <el-form-item label="下载次数">
                <el-switch v-model="shareForm.limitDownloads" active-text="限制次数" inactive-text="不限次数" />
                <el-input-number
                  v-if="shareForm.limitDownloads"
                  v-model="shareForm.maxDownloads"
                  :min="1"
                  controls-position="right"
                  class="share-form-input"
                />
              </el-form-item>
              <el-form-item label="访问控制">
                <el-switch v-model="shareForm.previewOnly" active-text="仅预览不可下载" inactive-text="允许下载" />
              </el-form-item>
              <el-form-item v-if="editingShareId" label="状态">
                <el-switch v-model="shareForm.enabled" active-text="启用" inactive-text="停用" />
              </el-form-item>
              <el-form-item v-if="!editingShareId" label="创建后复制">
                <el-segmented v-model="shareForm.copyTarget" :options="shareCopyOptions" />
              </el-form-item>
            </div>
          </div>

          <div class="share-form-section">
            <div class="share-form-section-title">高级设置</div>
            <div class="share-form-grid share-form-grid-wide">
              <el-form-item label="自定义分享后缀" class="share-form-span-2">
                <el-input
                  v-model="shareForm.customPath"
                  maxlength="200"
                  show-word-limit
                  placeholder="例如 docs/readme → 访问 /s/docs/readme；留空使用默认随机链接"
                >
                  <template #prepend>/s/</template>
                </el-input>
                <div class="muted share-form-hint">字母数字、下划线、中划线与 /；全局唯一，重复会提示。</div>
              </el-form-item>
              <el-form-item label="图片水印文字">
                <el-input
                  v-model="shareForm.watermarkText"
                  maxlength="64"
                  show-word-limit
                  placeholder="仅图片预览/下载生效，留空不加"
                />
              </el-form-item>
              <el-form-item label="访问 IP 白名单" class="share-form-span-2">
                <el-input
                  v-model="shareForm.allowedIpsText"
                  type="textarea"
                  :rows="2"
                  placeholder="每行或逗号分隔 IP / IPv4 CIDR，留空不限制"
                />
              </el-form-item>
            </div>
          </div>

          <div class="share-form-actions">
            <el-button v-if="editingShareId" @click="resetShareForm">取消编辑</el-button>
            <el-button type="primary" :loading="sharing" @click="submitShare">
              {{ editingShareId ? '保存修改' : '创建分享' }}
            </el-button>
          </div>
        </el-form>

        <div class="share-list-block">
          <div class="share-list-header">
            <span class="share-form-section-title">已有分享</span>
            <span class="muted">共 {{ shareLinks.length }} 条</span>
          </div>
          <TableViewport v-slot="{ pinActions }" label="文件分享列表">
          <el-table :data="shareLinks" row-key="id" size="small" empty-text="暂无分享，创建后显示在此">
            <el-table-column label="分享地址" min-width="280">
              <template #default="{ row }">
                <div class="share-links-cell">
                  <span class="mono">{{ row.url }}</span>
                  <span v-if="row.customPath" class="muted">自定义：/s/{{ row.customPath }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="限制" width="120">
              <template #default="{ row }">
                <div class="share-limit">
                  <span>{{ row.hasPassword ? '有密码' : '无密码' }}</span>
                  <span class="muted">{{ row.maxDownloads ? `${row.downloadCount}/${row.maxDownloads}` : `${row.downloadCount}/不限` }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="shareStatusMeta(row.status).type" size="small">{{ shareStatusMeta(row.status).label }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="220" :fixed="pinActions ? 'right' : false">
              <template #default="{ row }">
                <el-button link type="primary" @click="copyText(row.url)">复制</el-button>
                <el-button link type="primary" @click="copyText(row.downloadUrl)">直链</el-button>
                <el-button link type="primary" @click="editShare(row)">编辑</el-button>
                <el-button v-if="row.enabled" link type="danger" @click="disableShare(row.id)">停用</el-button>
              </template>
            </el-table-column>
          </el-table>
          </TableViewport>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="moveDialogVisible" :title="moveMode === 'copy' ? '复制文件' : '移动文件'" width="460px">
      <el-form label-position="top">
        <el-form-item v-if="moveMode === 'copy'" label="目标项目">
          <el-select v-model="moveForm.projectId" filterable clearable placeholder="留空复制到原项目" class="full-input">
            <el-option v-for="project in manageableProjects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="目标目录">
          <el-input v-model="moveForm.folderPath" placeholder="留空表示根目录" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="moveDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="moving" @click="submitMoveOrCopy">
          {{ moveMode === 'copy' ? '复制' : '移动' }}
        </el-button>
      </template>
    </el-dialog>

    <FileTextEditor
      v-if="contentFile" :key="contentFile.id" :file="contentFile" :editable="canManageFile(contentFile)"
      @close="contentFile = null" @saved="onContentSaved"
    />
    <el-dialog v-model="previewVisible" :title="previewFile?.originalName || '文件预览'" width="80%" @closed="destroyHlsPlayer">
      <div v-if="previewFile" class="preview-frame">
        <img v-if="previewFile.category === 'IMAGE'" :src="previewSource(previewFile)" :alt="previewFile.originalName" />
        <template v-else-if="previewFile.category === 'VIDEO'">
          <video
            ref="previewVideoRef"
            :src="previewFile.hlsUrl ? undefined : previewVideoSource(previewFile)"
            controls
            preload="metadata"
            class="preview-video"
          />
          <div v-if="previewFile.hlsUrl" class="muted preview-hint">HLS 多码率预览（自动降级到 progressive MP4）</div>
        </template>
        <audio v-else-if="previewFile.category === 'AUDIO'" :src="previewSource(previewFile)" controls />
        <iframe
          v-else-if="isPdfFile(previewFile)"
          :src="previewSource(previewFile)"
          :title="previewFile.originalName"
        />
        <div v-else-if="isOfficeFile(previewFile)" class="office-preview-fallback">
          <template v-if="officePreviewUrl">
            <iframe :src="officePreviewUrl" :title="previewFile.originalName" class="office-iframe" />
          </template>
          <template v-else>
            <p>Office 文档（Word / Excel / PPT）需要配置在线预览服务后才能内嵌打开。</p>
            <p class="muted">可在「系统设置」填写 KKFileView / OnlyOffice 地址；未配置时请下载后使用本地办公软件打开。</p>
            <el-button type="primary" @click="download(previewFile)">下载文件</el-button>
          </template>
        </div>
        <iframe v-else :src="previewSource(previewFile)" :title="previewFile.originalName" />
      </div>
    </el-dialog>

    <el-dialog
      v-model="versionsDialogVisible"
      :title="versionsFile ? `版本历史 — ${versionsFile.originalName}` : '版本历史'"
      width="780px"
    >
      <TableViewport v-slot="{ pinActions }" label="文件版本列表">
      <el-table v-loading="versionsLoading" :data="versions" row-key="id" size="small">
        <el-table-column label="版本" width="90">
          <template #default="{ row }">
            <span>v{{ row.version }}</span>
            <el-tag
              v-if="versionsFile && row.version === (versionsFile.currentVersion || 1)"
              size="small"
              type="success"
              class="version-current-tag"
            >
              当前
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="originalName" label="文件名" min-width="180" show-overflow-tooltip />
        <el-table-column label="大小" width="100">
          <template #default="{ row }">{{ formatSize(row.size) }}</template>
        </el-table-column>
        <el-table-column label="时间" min-width="160">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ row.remark || '-' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="100" :fixed="pinActions ? 'right' : false">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :disabled="Boolean(versionsFile && row.version === (versionsFile.currentVersion || 1))"
              :loading="restoringVersion === row.version"
              @click="restoreFileVersion(row.version)"
            >
              恢复
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      </TableViewport>
      <template #footer>
        <el-button @click="versionsDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ArrowDown, Back, Delete, Document, Download, FolderAdd, FolderOpened, MoreFilled, Refresh, Search, Upload } from '@element-plus/icons-vue';
import { useElementSize } from '@vueuse/core';
import TableViewport from '@/components/TableViewport.vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { TableInstance } from 'element-plus';
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, toRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { http } from '@/api/http';
import { fileStorageApi } from '@/api/file-storage';
import FileStorageDetails from '@/components/FileStorageDetails.vue';
import FileTextEditor from '@/components/FileTextEditor.vue';
import DownloadStorageInfo from '@/components/DownloadStorageInfo.vue';
import StorageLocationTags from '@/components/StorageLocationTags.vue';
import { uploadResults, retainUploadedFiles } from '@/stores/upload-results';
import { hasPendingReplicas, localReplicaResult, replicaSnapshotMatches, shouldAcceptReplicaSnapshot } from '@/utils/storage-replica-view';
import { cancelUploadQueue, fileApi, folderPublicApi, pauseUploadQueue, projectApi, resumeUploadQueue, settingsApi, uploadCredentialApi, uploadQueueState, waitForUploadQueue } from '@/api/modules';
import type { CdnProvider, DownloadStorageSource, FileCategory, FileReplicaDetail, FileStatus, ManagedFile, PageResult, Project, ShareLink, ShareStatus } from '@/types';
import { copyText, saveBlob } from '@/utils/io';

type FileListParams = Parameters<typeof fileApi.list>[0];

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const foldersLoading = ref(false);
const filesError = ref(false);
const foldersError = ref(false);
const folderPaneOpen = ref(false);
const fileTable = ref<TableInstance>();
const filesMain = ref<globalThis.HTMLElement>();
const { width: filesMainWidth } = useElementSize(filesMain);
const pinFileActions = computed(() => filesMainWidth.value >= 720);
let readGeneration = 0;
let readController: globalThis.AbortController | undefined;
let targetController: globalThis.AbortController | undefined;
let targetGeneration = 0;
const mountController = new globalThis.AbortController();
let projectContextGeneration = 0;
const dialogReads = new Map<string, globalThis.AbortController>();

function captureProjectContext(): () => boolean {
  const generation = projectContextGeneration;
  return () => generation === projectContextGeneration && !mountController.signal.aborted;
}

async function readDialog<T>(key: string, fetch: (signal: globalThis.AbortSignal) => Promise<T>, commit: (result: T) => void, busy?: { value: boolean }): Promise<void> {
  const generation = projectContextGeneration;
  dialogReads.get(key)?.abort();
  const controller = new globalThis.AbortController();
  dialogReads.set(key, controller);
  const current = () => generation === projectContextGeneration && dialogReads.get(key) === controller && !controller.signal.aborted;
  if (busy) busy.value = true;
  try {
    const result = await fetch(controller.signal);
    if (current()) commit(result);
  } catch { /* HTTP handles current errors; navigation cancellation is silent. */ }
  finally { if (current() && busy) busy.value = false; }
}
const uploading = toRef(uploadQueueState, 'active');
const editing = ref(false);
const sharing = ref(false);
const moving = ref(false);
const uploadProgress = toRef(uploadQueueState, 'progress');
const isDragging = ref(false);
const dragDepth = ref(0);
const uploadStrategy = ref<'reject' | 'reuse' | 'replace'>('reject');
const replaceTargetFileId = ref('');
const replaceFileInputRef = ref<HTMLInputElement | null>(null);
const pendingReplaceFileId = ref('');
const replaceTargetLoading = ref(false);
const replaceTargetOptions = ref<ManagedFile[]>([]);
const projects = ref<Project[]>([]);
const storageProviderOptions = computed(() => [...new Set([
  'LOCAL', ...projects.value.flatMap(project => (project.storages ?? []).map(storage => storage.provider)),
  ...pageResult.items.flatMap(file => file.cdnProvider ? [file.cdnProvider] : []),
])]);
const folders = ref<string[]>([]);
const folderTree = ref<Array<{ name: string; path: string; fileCount: number; children: unknown[] }>>([]);
const folderPublicPaths = ref<Set<string>>(new Set());
const selectedProjectId = ref(String(route.query.projectId || ''));
const selectedProject = computed(() => projects.value.find((project) => project.id === selectedProjectId.value));
const canManageSelectedProject = computed(() => Boolean(selectedProject.value?.canManage));
const isRecycleBin = computed(() => route.name === 'recycle-bin');
const showFolderPane = computed(
  () => Boolean(selectedProjectId.value) && !isRecycleBin.value,
);
const pageTitle = computed(() =>
  isRecycleBin.value ? '回收站' : '文件管理',
);
const pageSubtitle = computed(() =>
  isRecycleBin.value
    ? '本地及云存储对象保留，可恢复文件；确认彻底删除后才清理全部存储副本，不会到期自动删除。'
    : '汇总查看全部项目文件，也可以选择单个项目后上传、预览、下载和回收文件。'
);
const folderBreadcrumbs = computed(() => {
  if (!filters.folderPath) {
    return [] as Array<{ name: string; path: string }>;
  }
  const parts = filters.folderPath.split('/').filter(Boolean);
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join('/'),
  }));
});
const selectedRows = ref<ManagedFile[]>([]);
const downloadingIds = ref<Set<string>>(new Set());
const downloadResults = ref<Array<{ name: string; source: DownloadStorageSource | null; time: string }>>([]);
const fileInputRef = ref<HTMLInputElement>();
const folderInputRef = ref<HTMLInputElement>();
const previewVisible = ref(false);
const previewFile = ref<ManagedFile | null>(null);
const contentFile = ref<ManagedFile | null>(null);
const previewVideoRef = ref<HTMLVideoElement | null>(null);
const officePreviewBaseUrl = ref('');
const officePreviewUrl = computed(() => {
  const file = previewFile.value;
  const base = officePreviewBaseUrl.value.trim();
  if (!file || !base || !isOfficeFile(file)) {
    return '';
  }
  const access = fileAccessSource(file.accessUrl);
  if (!access) {
    return '';
  }
  const absolute =
    access.startsWith('http://') || access.startsWith('https://')
      ? access
      : `${window.location.origin}${access.startsWith('/') ? '' : '/'}${access}`;
  // KKFileView style: .../onlinePreview?url=<encoded>
  if (base.includes('url=')) {
    return `${base}${encodeURIComponent(absolute)}`;
  }
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}url=${encodeURIComponent(absolute)}`;
});
let hlsPlayer: { destroy: () => void } | null = null;
const versionsDialogVisible = ref(false);
const versionsLoading = ref(false);
const restoringVersion = ref<number | null>(null);
const versionsFile = ref<ManagedFile | null>(null);
const versions = ref<
  Array<{
    id: string;
    version: number;
    size: number;
    originalName: string;
    mimeType: string;
    checksum?: string | null;
    createdAt: string;
    remark?: string | null;
  }>
>([]);
const storageDetailsVisible = ref(false);
const storageDetailsFile = ref<ManagedFile | null>(null);
const storageSummaries = ref<Record<string, FileReplicaDetail>>({});
const storageSummaryError = ref(false);
const uploadResultPage = ref(1), uploadResultsLoading = ref(false), uploadResultsError = ref(false);
const visibleUploadResults = computed(() => uploadResults.files.slice((uploadResultPage.value - 1) * 20, uploadResultPage.value * 20));
let uploadResultController: globalThis.AbortController | undefined, uploadResultGeneration = 0;
let uploadResultTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

function storageLocations(file: ManagedFile) {
  const snapshot = storageSummaries.value[file.id];
  return snapshot && replicaSnapshotMatches(file, snapshot) ? snapshot.items : null;
}
function openStorageDetails(file: ManagedFile): void { storageDetailsFile.value = file; storageDetailsVisible.value = true; }
function acceptStorageDetails(snapshot: FileReplicaDetail, file: ManagedFile): void {
  const existing = storageSummaries.value[file.id];
  if (!shouldAcceptReplicaSnapshot(file, snapshot, existing)) return;
  storageSummaries.value[file.id] = snapshot;
  const index = pageResult.items.findIndex(item => item.id === file.id && item.projectId === file.projectId);
  if (index >= 0 && (pageResult.items[index].currentVersion || 1) <= (file.currentVersion || 1)) pageResult.items[index] = file;
  const uploadedIndex = uploadResults.files.findIndex(item => item.id === file.id);
  if (uploadedIndex >= 0 && (uploadResults.files[uploadedIndex].currentVersion || 1) <= (file.currentVersion || 1)) uploadResults.files[uploadedIndex] = file;
}
async function fetchStorageSummaries(files: ManagedFile[], signal: globalThis.AbortSignal, current: () => boolean): Promise<void> {
  if (!files.length) return;
  const requested = new Map(files.map(file => [file.id, file]));
  const result = await fileStorageApi.batch([...requested.keys()], { signal, _silent: true });
  if (!current()) return;
  for (const item of result.items) {
    const file = requested.get(item.fileId), existing = storageSummaries.value[item.fileId];
    if (file && shouldAcceptReplicaSnapshot(file, item, existing)) storageSummaries.value[item.fileId] = item;
  }
}
async function loadUploadResultStorage(): Promise<void> {
  globalThis.clearTimeout(uploadResultTimer); uploadResultController?.abort();
  const controller = new globalThis.AbortController(), generation = ++uploadResultGeneration;
  uploadResultController = controller;
  const files = visibleUploadResults.value;
  if (!files.length || mountController.signal.aborted) return;
  const current = () => generation === uploadResultGeneration && !controller.signal.aborted && !mountController.signal.aborted;
  uploadResultsLoading.value = true;
  try { await fetchStorageSummaries(files, controller.signal, current); if (current()) uploadResultsError.value = false; }
  catch { if (current()) uploadResultsError.value = true; }
  finally {
    if (current()) {
      uploadResultsLoading.value = false;
      if (uploadResultsError.value || files.some(file => hasPendingReplicas(storageLocations(file) || []))) uploadResultTimer = globalThis.setTimeout(() => { void loadUploadResultStorage(); }, 3000);
    }
  }
}
const editDialogVisible = ref(false);
const editingFile = ref<ManagedFile | null>(null);
const moveFile = ref<ManagedFile | null>(null);
const moveDialogVisible = ref(false);
const moveMode = ref<'move' | 'copy'>('move');
const moveBatch = ref(false);
const shareDialogVisible = ref(false);
const shareFile = ref<ManagedFile | null>(null);
const shareLinks = ref<ShareLink[]>([]);
const filters = reactive<{
  keyword: string;
  category: FileCategory | '';
  status: FileStatus;
  tag: string;
  folderPath: string;
  extension: string;
  cdnProvider: CdnProvider | '';
  duplicateOnly: boolean;
  minSizeMb?: number;
  maxSizeMb?: number;
  dateRange: string[];
}>({
  keyword: '',
  category: '',
  status: route.name === 'recycle-bin' ? 'RECYCLED' : 'ACTIVE',
  tag: '',
  folderPath: readRouteFolderPath(),
  extension: '',
  cdnProvider: '',
  duplicateOnly: false,
  minSizeMb: undefined,
  maxSizeMb: undefined,
  dateRange: [],
});
const editForm = reactive({
  originalName: '',
  folderPath: '',
  tags: '',
  remark: '',
  isPublic: false,
});
const shareForm = reactive<{
  requiresPassword: boolean;
  password: string;
  expiresAt: string;
  limitDownloads: boolean;
  maxDownloads?: number;
  enabled: boolean;
  copyTarget: 'page' | 'download';
  previewOnly: boolean;
  watermarkText: string;
  customPath: string;
  allowedIpsText: string;
}>({
  requiresPassword: false,
  password: '',
  expiresAt: '',
  limitDownloads: false,
  maxDownloads: undefined,
  enabled: true,
  copyTarget: 'page',
  previewOnly: false,
  watermarkText: '',
  customPath: '',
  allowedIpsText: '',
});
const editingShareId = ref('');
const editingShareHadPassword = ref(false);
const shareCopyOptions = [
  { label: '分享页', value: 'page' },
  { label: '直链下载', value: 'download' },
];
const moveForm = reactive({
  projectId: '',
  folderPath: '',
});
const manageableProjects = computed(() => projects.value.filter((project) => project.canManage));
const canManageSelectedRows = computed(
  () => selectedRows.value.length > 0 && selectedRows.value.every((file) => canManageFile(file)),
);
const pageResult = reactive<PageResult<ManagedFile>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});
const categoryOptions: Array<{ label: string; value: FileCategory }> = [
  { label: '图片', value: 'IMAGE' },
  { label: '文档', value: 'DOCUMENT' },
  { label: '视频', value: 'VIDEO' },
  { label: '音频', value: 'AUDIO' },
  { label: '压缩包', value: 'ARCHIVE' },
  { label: '代码', value: 'CODE' },
  { label: '其他', value: 'OTHER' },
];
function categoryLabel(category: FileCategory): string {
  return categoryOptions.find((item) => item.value === category)?.label || category;
}

function shareStatusMeta(status: ShareStatus): { label: string; type: 'success' | 'info' | 'warning' | 'danger' } {
  const meta: Record<ShareStatus, { label: string; type: 'success' | 'info' | 'warning' | 'danger' }> = {
    ACTIVE: { label: '有效', type: 'success' },
    DISABLED: { label: '停用', type: 'info' },
    EXPIRED: { label: '已过期', type: 'warning' },
    EXHAUSTED: { label: '次数耗尽', type: 'danger' },
  };

  return meta[status];
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

function canManageFile(file: ManagedFile): boolean {
  return Boolean(projects.value.find((project) => project.id === file.projectId)?.canManage);
}

async function loadProjects(): Promise<void> {
  try {
    const result = await projectApi.list(undefined, { signal: mountController.signal });
    if (mountController.signal.aborted) return;
    projects.value = result;
    syncSelectedProjectFromRoute();
  } catch { /* HTTP errors are already surfaced; canceled navigation is silent. */ }
}

function syncSelectedProjectFromRoute(): void {
  const routeProjectId = readRouteProjectId();

  if (routeProjectId && projects.value.some((project) => project.id === routeProjectId)) {
    selectedProjectId.value = routeProjectId;
    return;
  }

  if (selectedProjectId.value && !projects.value.some((project) => project.id === selectedProjectId.value)) {
    selectedProjectId.value = '';
  }
}

function readRouteProjectId(): string {
  const value = route.query.projectId;
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function readRouteFolderPath(): string {
  const value = route.query.folderPath;
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

async function reloadFirstPage(): Promise<void> {
  pageResult.page = 1;
  await reload();
}

async function handleProjectFilterChange(): Promise<void> {
  filters.folderPath = '';
  pageResult.page = 1;
  const query = { ...route.query, projectId: selectedProjectId.value || undefined, folderPath: undefined };
  if (readRouteProjectId() !== selectedProjectId.value) await router.push({ path: route.path, query });
  else await reload();
}

async function reload(): Promise<void> {
  selectedRows.value = [];
  filters.status = isRecycleBin.value ? 'RECYCLED' : 'ACTIVE';
  readController?.abort();
  const controller = new globalThis.AbortController();
  readController = controller;
  const generation = ++readGeneration;
  const projectId = selectedProjectId.value;
  const params = buildListParams(projectId || undefined, pageResult.page, pageResult.pageSize);
  const options = { signal: controller.signal };
  const current = () => generation === readGeneration && projectId === selectedProjectId.value && !controller.signal.aborted;
  loading.value = true;
  filesError.value = false;
  foldersError.value = false;
  // Each panel commits independently. Slow directory services never hold up files.
  if (projectId && !isRecycleBin.value) {
    foldersLoading.value = true;
    void fileApi.listFolders(projectId, options).then(result => {
      if (current()) folders.value = result;
    }).catch(() => {});
    void fileApi.listFolderTree(projectId, options).then(result => {
      if (current()) folderTree.value = result;
    }).catch(() => { if (current()) foldersError.value = true; }).finally(() => { if (current()) foldersLoading.value = false; });
    void folderPublicApi.list(projectId, options).then(result => {
      if (current()) folderPublicPaths.value = new Set(result.filter(item => item.isPublic).map(item => item.folderPath || ''));
    }).catch(() => {});
  } else {
    folders.value = [];
    folderTree.value = [];
    folderPublicPaths.value = new Set();
    foldersLoading.value = false;
  }
  try {
    const result = await fileApi.list(params, options);
    if (!current()) return;
    pageResult.items = result.items;
    pageResult.total = result.total;
    pageResult.page = result.page;
    pageResult.pageSize = result.pageSize;
    storageSummaryError.value = false;
    void fetchStorageSummaries(result.items, controller.signal, current).catch(() => { if (current()) storageSummaryError.value = true; });
  } catch {
    if (current()) filesError.value = true;
  } finally {
    if (current()) loading.value = false;
  }
}

async function selectFolder(path: string): Promise<void> {
  filters.folderPath = path;
  await reloadFirstPage();
}

function onFolderNodeClick(data: { path?: string }): void {
  void selectFolder(data.path || '');
}

function isFolderPublic(path: string): boolean {
  return folderPublicPaths.value.has(path || '');
}

async function handleFolderCommand(command: string, path: string): Promise<void> {
  if (!selectedProjectId.value || !canManageSelectedProject.value) {
    return;
  }
  const projectId = selectedProjectId.value;
  const folderPath = path || '';
  if (command === 'create-child') {
    await createFolder(folderPath);
    return;
  }
  if (command === 'delete-folder') {
    await removeFolder(folderPath);
    return;
  }
  if (command === 'public-on') {
    await folderPublicApi.upsert(projectId, { folderPath, isPublic: true });
    ElMessage.success('已设置文件夹公开策略（路径继承）。');
    await reload();
    return;
  }
  if (command === 'public-off') {
    await folderPublicApi.remove(projectId, folderPath);
    ElMessage.success('已取消文件夹公开策略。');
    await reload();
    return;
  }
  if (command === 'batch-public' || command === 'batch-private') {
    const isPublic = command === 'batch-public';
    await ElMessageBox.confirm(
      isPublic
        ? '将把该目录下现有有效文件批量标记为公开（isPublic=true）。'
        : '将把该目录下现有公开文件批量取消公开。',
      '批量公开',
      { type: 'warning', confirmButtonText: '继续', cancelButtonText: '取消' },
    );
    const result = await folderPublicApi.batchPublish(projectId, {
      folderPath,
      isPublic,
      recursive: true,
    });
    ElMessage.success(`已更新 ${result.updated} 个文件。`);
    await reload();
    return;
  }
  if (command === 'folder-share') {
    await createFolderShare(folderPath);
  }
}

async function createFolderShare(folderPath: string): Promise<void> {
  if (!selectedProjectId.value) {
    return;
  }
  try {
    const { value: password } = await ElMessageBox.prompt('可选：设置访问密码（留空表示无密码）', '分享目录', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPlaceholder: '访问密码（可选）',
      inputValue: '',
    }).catch(() => ({ value: null as string | null }));
    if (password === null) {
      return;
    }
    const result = (await http.post(`/projects/${selectedProjectId.value}/folder-shares`, {
      folderPath,
      password: password || undefined,
    })) as { url?: string };
    if (result.url) {
      await copyText(result.url);
      ElMessage.success('目录分享已创建，链接已复制。');
    } else {
      ElMessage.success('目录分享已创建。');
    }
  } catch (error) {
    if (error === 'cancel' || error === 'close') {
      return;
    }
    ElMessage.error(error instanceof Error ? error.message : '创建目录分享失败');
  }
}

async function toggleFilePublic(file: ManagedFile): Promise<void> {
  const next = !file.isPublic;
  await fileApi.update(file.id, { isPublic: next });
  ElMessage.success(
    next
      ? '文件已公开：未在授权名单的域名也可访问该直链。'
      : '已取消公开：需通过登录授权或临时签名链接访问。',
  );
  await reload();
}

function copyPublicUrl(file: ManagedFile): void {
  const base = window.location.origin.replace(/\/$/, '');
  // Stable fileId-based path. Domain policy is enforced by the public endpoint:
  // public files are open; non-public files only from authorized domains / signed links.
  const url = file.accessUrl || file.publicUrl || `${base}/api/public/files/${file.id}`;
  void copyText(new URL(String(url), base).toString());
  ElMessage.success(file.isPublic ? '公开直链已复制（任意域名可访问）。' : '文件地址已复制（私有文件需授权生成临时访问链接）。');
}

function buildListParams(projectId: string | undefined, page: number, pageSize: number): FileListParams {
  const status = isRecycleBin.value
    ? 'RECYCLED'
    : filters.status === 'ACTIVE'
        ? undefined
        : filters.status;
  // When a project is selected and the user is browsing folders (not recycle bin),
  // always send folderPath — empty string means root-only (folderPath IS NULL on the API).
  // When no project is selected, omit folderPath so the list is unfiltered across projects.
  const folderPath =
    projectId && !isRecycleBin.value
      ? filters.folderPath
      : filters.folderPath || undefined;

  return {
    projectId,
    keyword: filters.keyword || undefined,
    category: filters.category || undefined,
    status,
    tag: filters.tag || undefined,
    folderPath,
    extension: filters.extension || undefined,
    cdnProvider: filters.cdnProvider || undefined,
    duplicateOnly: filters.duplicateOnly || undefined,
    minSize: toBytes(filters.minSizeMb),
    maxSize: toBytes(filters.maxSizeMb),
    uploadedStartAt: filters.dateRange[0] ? `${filters.dateRange[0]}T00:00:00.000Z` : undefined,
    uploadedEndAt: filters.dateRange[1] ? `${filters.dateRange[1]}T23:59:59.999Z` : undefined,
    page,
    pageSize,
  };
}

function toBytes(value?: number): number | undefined {
  return value && value > 0 ? Math.floor(value * 1024 * 1024) : undefined;
}

function handleSelectionChange(rows: ManagedFile[]): void {
  selectedRows.value = rows;
}

function handleThumbError(file: ManagedFile): void {
  file.thumbnailUrl = null;
}

function resetUploadVisibilityFilters(): void {
  filters.keyword = '';
  filters.category = '';
  filters.status = 'ACTIVE';
  filters.tag = '';
  filters.extension = '';
  filters.cdnProvider = '';
  filters.duplicateOnly = false;
  filters.minSizeMb = undefined;
  filters.maxSizeMb = undefined;
  filters.dateRange = [];
}

function goFiles(): void {
  void router.push({ path: '/files', query: selectedProjectId.value ? { projectId: selectedProjectId.value } : {} });
}

function handleDragEnter(): void {
  if (isRecycleBin.value || !canManageSelectedProject.value || uploading.value) {
    return;
  }
  dragDepth.value += 1;
  isDragging.value = true;
}

function handleDragOver(): void {
  if (isRecycleBin.value || !canManageSelectedProject.value || uploading.value) {
    return;
  }
  isDragging.value = true;
}

function handleDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
  if (dragDepth.value === 0) {
    isDragging.value = false;
  }
}

async function handleDrop(event: DragEvent): Promise<void> {
  dragDepth.value = 0;
  isDragging.value = false;

  if (!selectedProjectId.value || !canManageSelectedProject.value || uploading.value) {
    return;
  }

  const files = Array.from(event.dataTransfer?.files || []);
  await uploadFiles(files);
}

async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  await uploadFiles(files);
}

async function handleReplaceFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  const targetFileId = pendingReplaceFileId.value;
  pendingReplaceFileId.value = '';
  if (!targetFileId || files.length === 0) {
    return;
  }
  await uploadFiles(files.slice(0, 1), {
    duplicateStrategy: 'replace',
    targetFileId,
  });
}

function startReplaceUpload(file: ManagedFile): void {
  if (!canManageFile(file)) {
    return;
  }
  if (!selectedProjectId.value) {
    selectedProjectId.value = file.projectId;
  }
  // Keep the selected target in the toolbar as well, so users can re-upload easily.
  replaceTargetFileId.value = file.id;
  if (!replaceTargetOptions.value.some((item) => item.id === file.id)) {
    replaceTargetOptions.value = [file, ...replaceTargetOptions.value].slice(0, 50);
  }
  pendingReplaceFileId.value = file.id;
  replaceFileInputRef.value?.click();
}

function triggerReplaceUpload(): void {
  if (!replaceTargetFileId.value) {
    ElMessage.warning('请先选择要覆盖的目标文件。');
    return;
  }
  pendingReplaceFileId.value = replaceTargetFileId.value;
  replaceFileInputRef.value?.click();
}

async function searchReplaceTargets(keyword: string): Promise<void> {
  targetController?.abort();
  const controller = new globalThis.AbortController();
  targetController = controller;
  const generation = ++targetGeneration;
  const projectId = selectedProjectId.value;
  const current = () => generation === targetGeneration && projectId === selectedProjectId.value && !controller.signal.aborted;
  if (!selectedProjectId.value || !canManageSelectedProject.value) {
    replaceTargetOptions.value = [];
    return;
  }
  replaceTargetLoading.value = true;
  try {
    const result = await fileApi.list({
      projectId,
      keyword: keyword?.trim() || undefined,
      status: 'ACTIVE',
      page: 1,
      pageSize: 30,
    }, { signal: controller.signal });
    if (current()) replaceTargetOptions.value = result.items;
  } catch {
    // Navigation cancels remote target searches.
  } finally {
    if (current()) replaceTargetLoading.value = false;
  }
}

async function handleFileCommand(command: string, file: ManagedFile): Promise<void> {
  switch (command) {
    case 'public':
      await toggleFilePublic(file);
      return;
    case 'public-url':
      await copyPublicUrl(file);
      return;
    case 'versions':
      await openVersionsDialog(file);
      return;
    case 'replace':
      startReplaceUpload(file);
      return;
    case 'move':
      openMoveDialog(file);
      return;
    case 'copy':
      openCopyDialog(file);
      return;
    case 'delete':
      await recycle(file);
      return;
    default:
      return;
  }
}

async function openVersionsDialog(file: ManagedFile): Promise<void> {
  versionsFile.value = file;
  versionsDialogVisible.value = true;
  versions.value = [];
  await readDialog('versions', signal => fileApi.listVersions(file.id, { signal }), result => { versions.value = result; }, versionsLoading);
}

async function restoreFileVersion(version: number): Promise<void> {
  if (!versionsFile.value) {
    return;
  }
  const file = versionsFile.value;
  const current = captureProjectContext();
  try {
    await ElMessageBox.confirm(
      `确认将「${file.originalName}」恢复到版本 v${version}？当前内容会先归档为新历史版本。`,
      '恢复历史版本',
      { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  if (!current()) return;

  restoringVersion.value = version;
  try {
    await fileApi.restoreVersion(file.id, version);
    if (!current()) return;
    ElMessage.success(`已恢复到版本 v${version}。`);
    versionsDialogVisible.value = false;
    await reload();
  } catch (error) {
    if (current()) ElMessage.error(error instanceof Error ? error.message : '恢复版本失败。');
  } finally {
    if (current()) restoringVersion.value = null;
  }
}

async function uploadFiles(
  files: File[],
  override?: {
    duplicateStrategy?: 'reject' | 'reuse' | 'replace';
    targetFileId?: string;
  },
): Promise<void> {
  if (uploading.value || !selectedProjectId.value || !canManageSelectedProject.value || files.length === 0) {
    return;
  }

  const projectId = selectedProjectId.value;
  const folderPath = filters.folderPath;
  const duplicateStrategy = override?.duplicateStrategy || uploadStrategy.value;
  const targetFileId = override?.targetFileId || replaceTargetFileId.value || undefined;

  if (targetFileId && files.length !== 1) {
    ElMessage.warning('指定文件覆盖时一次只能上传一个文件。');
    return;
  }
  // Files above the threshold upload in resumable chunks so a transient failure
  // only re-sends the affected chunk; smaller files use one multipart request.
  const chunkThreshold = 10 * 1024 * 1024;
  const smallFiles = files.filter((file) => file.size <= chunkThreshold);
  const largeFiles = files.filter((file) => file.size > chunkThreshold);
  const totalCount = files.length;
  let doneCount = 0;

  uploading.value = true;
  uploadQueueState.projectId = projectId;
  uploadQueueState.projectName = selectedProject.value?.name || projectId;
  uploadQueueState.paused = false;
  uploadQueueState.canceled = false;
  uploadQueueState.error = '';
  uploadResults.projectId = projectId;
  uploadResults.projectName = uploadQueueState.projectName;
  uploadResults.files = [];
  uploadResults.startedAt = new Date().toISOString();
  uploadResults.finishedAt = '';
  uploadResultPage.value = 1;
  uploadProgress.value = 0;
  let reusedCount = 0;
  // Overwrite always renames to the uploaded file's name (single-file only).
  let overwriteNewName = targetFileId && files[0] ? files[0].name : '';
  try {
    if (smallFiles.length > 0) {
      const formData = new FormData();
      smallFiles.forEach((file) => {
        const relativePath = (file as globalThis.File & { webkitRelativePath?: string }).webkitRelativePath;
        formData.append('files', file, relativePath || file.name);
      });
      const uploaded = await runQueuedUpload(() => fileApi.upload(projectId, formData, {
        folderPath,
        duplicateStrategy,
        targetFileId,
        onUploadProgress: (progress) => {
          uploadProgress.value = Math.round(((doneCount + (progress / 100) * smallFiles.length) / totalCount) * 100);
        },
      }));
      if (Array.isArray(uploaded)) {
        retainUploadedFiles(uploaded);
        reusedCount += uploaded.filter((item) => item.duplicateReused).length;
        if (targetFileId && uploaded[0]?.originalName) {
          overwriteNewName = String(uploaded[0].originalName);
        }
      }
      doneCount += smallFiles.length;
      uploadProgress.value = Math.round((doneCount / totalCount) * 100);
    }

    for (const file of largeFiles) {
      const uploaded = await runQueuedUpload(() => uploadCredentialApi.uploadDirectOrResumable(projectId, file, {
        folderPath,
        duplicateStrategy,
        targetFileId,
        beforeTransfer: waitForUploadQueue,
        onAuthExpired: async () => {
          pauseUploadQueue('登录已过期，请登录后返回文件管理并继续上传。文件仍保留在当前浏览器会话中。');
          await waitForUploadQueue();
        },
        onProgress: (progress) => {
          uploadProgress.value = Math.round(((doneCount + progress / 100) / totalCount) * 100);
        },
      }));
      if (uploaded?.duplicateReused) {
        reusedCount += 1;
      }
      if (uploaded?.id) retainUploadedFiles([uploaded]);
      if (targetFileId && uploaded && typeof uploaded === 'object' && 'originalName' in uploaded && uploaded.originalName) {
        overwriteNewName = String(uploaded.originalName);
      }
      doneCount += 1;
      uploadProgress.value = Math.round((doneCount / totalCount) * 100);
    }

    await waitForUploadQueue();
    if (reusedCount > 0 && duplicateStrategy === 'reuse') {
      ElMessage.success(
        reusedCount === totalCount
          ? `秒传成功（${reusedCount} 个文件已复用）。`
          : `上传完成，其中 ${reusedCount} 个秒传复用。`,
      );
    } else {
      if (targetFileId) {
        ElMessage.success(
          overwriteNewName
            ? `覆盖完成：fileId 不变，文件名已更新为「${overwriteNewName}」。`
            : '覆盖完成：fileId / 直链 / 分享保持不变，文件名已按上传文件更新。',
        );
      } else if (duplicateStrategy === 'replace') {
        ElMessage.success('文件上传/覆盖完成。');
      } else {
        ElMessage.success('文件上传完成。');
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_CANCELED') throw error;
  } finally {
    uploading.value = false;
    uploadQueueState.paused = false;
    uploadResults.finishedAt = new Date().toISOString();
  }
}

async function runQueuedUpload<T>(transfer: () => Promise<T>): Promise<T> {
  for (;;) {
    await waitForUploadQueue();
    try {
      return await transfer();
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_CANCELED') throw error;
      const status = (error as { response?: { status?: number } }).response?.status;
      pauseUploadQueue(status === 401
        ? '登录已过期，请登录后返回文件管理并继续上传。文件仍保留在当前浏览器会话中。'
        : '上传未完成，文件已保留。请检查连接后继续上传，或取消本次上传。');
      await waitForUploadQueue();
    }
  }
}

async function createFolder(parentPath = filters.folderPath): Promise<void> {
  if (!selectedProjectId.value || !canManageSelectedProject.value) {
    return;
  }
  const current = captureProjectContext();
  const projectId = selectedProjectId.value;

  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt(`在 ${parentPath || '根目录'} 下创建目录（可包含多级，如 contracts/2026）`, '新建文件夹', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputPattern: /^[^\\:*?"<>|]+$/,
      inputErrorMessage: '目录名不能包含 \\ : * ? " < > |',
    }));
  } catch { return; }
  if (!current()) return;

  const name = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!name) {
    ElMessage.warning('目录名不能为空。');
    return;
  }

  const folderPath = [parentPath, name].filter(Boolean).join('/');
  await fileApi.createFolder(projectId, folderPath);
  if (!current()) return;
  ElMessage.success('目录已创建。');
  await reload();
}

async function removeFolder(folderPath: string): Promise<void> {
  if (!selectedProjectId.value || !canManageSelectedProject.value || !folderPath) return;
  const current = captureProjectContext();
  const projectId = selectedProjectId.value;
  type Node = { path: string; fileCount: number; children: unknown[] };
  const find = (nodes: Node[]): Node | undefined => {
    for (const node of nodes) {
      if (node.path === folderPath) return node;
      const child = find(node.children as Node[]);
      if (child) return child;
    }
    return undefined;
  };
  const node = find(folderTree.value);
  const hasFiles = (item: Node): boolean => item.fileCount > 0 || (item.children as Node[]).some(hasFiles);
  if (node && hasFiles(node)) { ElMessage.warning('目录中存在文件，请先删除目录及子目录中的文件。'); return; }
  if (node?.children.length) { ElMessage.warning('目录中存在子目录，请先删除子目录。'); return; }
  try {
    await ElMessageBox.confirm(`确认删除目录 ${folderPath}？仅允许删除空目录；有文件时请先删除文件，有子目录时请先删除子目录。回收站文件仍可恢复。`, '删除空目录', {
      type: 'warning', confirmButtonText: '删除目录', cancelButtonText: '取消',
    });
  } catch { return; }
  if (!current()) return;
  await fileApi.removeFolder(projectId, folderPath);
  if (!current()) return;
  if (filters.folderPath === folderPath || filters.folderPath.startsWith(`${folderPath}/`)) filters.folderPath = folderPath.split('/').slice(0, -1).join('/');
  ElMessage.success('空目录已删除。');
  await reload();
}
async function openPreview(file: ManagedFile): Promise<void> {
  if (file.textEditable) { contentFile.value = file; return; }
  if (!file.isPublic) file = await fileApi.getMetadata(file.id);
  destroyHlsPlayer();
  previewFile.value = file;
  previewVisible.value = true;
  if (file.category === 'VIDEO' && file.hlsUrl) {
    void nextTick(() => attachHlsPlayer(file));
  }
}

function previewSource(file: ManagedFile): string {
  return fileAccessSource(file.previewUrl || file.accessUrl);
}

function onContentSaved(file: ManagedFile): void {
  if (contentFile.value?.id !== file.id) return;
  contentFile.value = file;
  void reload();
}

function previewVideoSource(file: ManagedFile & { progressiveUrl?: string | null; hlsUrl?: string | null }): string {
  return fileAccessSource(file.progressiveUrl || file.previewUrl || file.accessUrl);
}

function destroyHlsPlayer(): void {
  if (hlsPlayer) {
    try {
      hlsPlayer.destroy();
    } catch {
      // Preview teardown is best-effort.
    }
    hlsPlayer = null;
  }
}

async function attachHlsPlayer(file: ManagedFile & { hlsUrl?: string | null; progressiveUrl?: string | null }): Promise<void> {
  const video = previewVideoRef.value;
  const src = fileAccessSource(file.hlsUrl);
  if (!video || !src) {
    return;
  }

  // Native HLS (Safari)
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    return;
  }

  try {
    // Variable URL so vue-tsc does not try to resolve a remote string-literal module.
    const hlsCdnUrl = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/+esm';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ hlsCdnUrl);
    const Hls = mod?.default ?? mod;
    const isSupported = typeof Hls?.isSupported === 'function' ? Hls.isSupported : mod?.isSupported;
    if (!Hls || (typeof isSupported === 'function' && !isSupported())) {
      video.src = previewVideoSource(file);
      return;
    }
    const instance = new Hls({ enableWorker: true });
    instance.loadSource(src);
    instance.attachMedia(video);
    instance.on('hlsError', () => {
      // Fall back to progressive MP4 / original on fatal stream issues.
      destroyHlsPlayer();
      video.src = previewVideoSource(file);
    });
    hlsPlayer = instance;
  } catch {
    video.src = previewVideoSource(file);
  }
}

function isPdfFile(file: ManagedFile): boolean {
  return file.mimeType === 'application/pdf' || (file.extension || '').toLowerCase() === 'pdf';
}

function isOfficeFile(file: ManagedFile): boolean {
  const ext = (file.extension || '').toLowerCase();
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) {
    return true;
  }
  const mime = (file.mimeType || '').toLowerCase();
  return (
    mime.includes('officedocument') ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.ms-powerpoint'
  );
}

function fileAccessSource(value?: string | null): string {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value, window.location.origin);
    if (url.pathname.startsWith('/api/public/files/')) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    return value;
  }

  return value;
}

function openEditDialog(file: ManagedFile): void {
  editingFile.value = file;
  editForm.originalName = file.originalName;
  editForm.folderPath = file.folderPath || '';
  editForm.tags = file.tags.join(', ');
  editForm.remark = file.remark || '';
  editForm.isPublic = Boolean(file.isPublic);
  editDialogVisible.value = true;
}

function openMoveDialog(file: ManagedFile): void {
  moveMode.value = 'move';
  moveBatch.value = false;
  moveFile.value = file;
  moveForm.projectId = file.projectId;
  moveForm.folderPath = file.folderPath || '';
  moveDialogVisible.value = true;
}

function openCopyDialog(file: ManagedFile): void {
  moveMode.value = 'copy';
  moveBatch.value = false;
  moveFile.value = file;
  moveForm.projectId = file.projectId;
  moveForm.folderPath = file.folderPath || '';
  moveDialogVisible.value = true;
}

function openBatchMoveDialog(): void {
  if (!canManageSelectedRows.value) {
    return;
  }

  moveMode.value = 'move';
  moveBatch.value = true;
  moveFile.value = null;
  moveForm.projectId = selectedProjectId.value;
  moveForm.folderPath = filters.folderPath;
  moveDialogVisible.value = true;
}

function openBatchCopyDialog(): void {
  if (!canManageSelectedRows.value) {
    return;
  }

  moveMode.value = 'copy';
  moveBatch.value = true;
  moveFile.value = null;
  moveForm.projectId = selectedProjectId.value;
  moveForm.folderPath = filters.folderPath;
  moveDialogVisible.value = true;
}

async function submitMoveOrCopy(): Promise<void> {
  const current = captureProjectContext();
  if (moveBatch.value && !canManageSelectedRows.value) {
    return;
  }

  if (!moveBatch.value && moveFile.value && !canManageFile(moveFile.value)) {
    return;
  }

  moving.value = true;
  try {
    if (moveBatch.value) {
      if (moveMode.value === 'move') {
        await fileApi.batchMove(selectedRows.value.map((file) => file.id), moveForm.folderPath || null);
        if (!current()) return;
        ElMessage.success('文件已移动。');
      } else {
        const result = await fileApi.batchCopy(
          selectedRows.value.map((file) => file.id),
          moveForm.folderPath || null,
          moveForm.projectId || undefined,
        );
        if (!current()) return;
        if (result.failed > 0) {
          ElMessage.warning(`复制成功 ${result.copied} 个，失败 ${result.failed} 个。`);
        } else {
          ElMessage.success('文件已复制。');
        }
      }
    } else if (moveFile.value) {
      if (moveMode.value === 'move') {
        await fileApi.move(moveFile.value.id, { folderPath: moveForm.folderPath || null });
        if (!current()) return;
        ElMessage.success('文件已移动。');
      } else {
        await fileApi.copy(moveFile.value.id, {
          projectId: moveForm.projectId || moveFile.value.projectId,
          folderPath: moveForm.folderPath || null,
        });
        if (!current()) return;
        ElMessage.success('文件已复制。');
      }
    }

    moveDialogVisible.value = false;
    await reload();
  } finally {
    if (current()) moving.value = false;
  }
}

async function submitEdit(): Promise<void> {
  if (!editingFile.value) {
    return;
  }
  const current = captureProjectContext();

  editing.value = true;
  try {
    await fileApi.update(editingFile.value.id, {
      originalName: editForm.originalName,
      folderPath: editForm.folderPath,
      tags: readTagList(editForm.tags),
      remark: editForm.remark,
      isPublic: editForm.isPublic,
    });
    if (!current()) return;
    editDialogVisible.value = false;
    ElMessage.success('文件信息已更新。');
    await reload();
  } finally {
    if (current()) editing.value = false;
  }
}

function readTagList(value: string): string[] {
  return value
    .split(/[,，\n\r]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function openShareDialog(file: ManagedFile): Promise<void> {
  shareFile.value = file;
  resetShareForm();
  shareDialogVisible.value = true;
  await loadShares(file.id);
}

async function loadShares(fileId: string): Promise<void> {
  shareLinks.value = [];
  await readDialog('shares', signal => fileApi.listShares(fileId, { signal }), result => { shareLinks.value = result; });
}

function resetShareForm(): void {
  editingShareId.value = '';
  editingShareHadPassword.value = false;
  shareForm.requiresPassword = false;
  shareForm.password = '';
  shareForm.expiresAt = '';
  shareForm.limitDownloads = false;
  shareForm.maxDownloads = undefined;
  shareForm.enabled = true;
  shareForm.copyTarget = 'page';
  shareForm.previewOnly = false;
  shareForm.watermarkText = '';
  shareForm.customPath = '';
  shareForm.allowedIpsText = '';
}

function editShare(share: ShareLink): void {
  editingShareId.value = share.id;
  editingShareHadPassword.value = share.hasPassword;
  shareForm.requiresPassword = share.hasPassword;
  shareForm.password = '';
  shareForm.expiresAt = share.expiresAt ? toDatePickerValue(share.expiresAt) : '';
  shareForm.limitDownloads = share.maxDownloads !== null && share.maxDownloads !== undefined;
  shareForm.maxDownloads = share.maxDownloads ?? undefined;
  shareForm.enabled = share.enabled;
  shareForm.previewOnly = share.previewOnly;
  shareForm.watermarkText = share.watermarkText ?? '';
  shareForm.customPath = share.customPath ?? '';
  shareForm.allowedIpsText = (share.allowedIps ?? []).join('\n');
}

function toDatePickerValue(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return `${date.toISOString().slice(0, 19)}Z`;
}

function parseAllowedIps(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

async function submitShare(): Promise<void> {
  if (editingShareId.value) {
    await updateShare();
    return;
  }

  await createShare();
}

async function createShare(): Promise<void> {
  if (!shareFile.value) {
    return;
  }

  if (!validateShareForm(false)) {
    return;
  }
  const current = captureProjectContext();
  const fileId = shareFile.value.id;

  sharing.value = true;
  try {
    const copyTarget = shareForm.copyTarget;
    const share = await fileApi.createShare(fileId, {
      password: shareForm.requiresPassword ? shareForm.password : undefined,
      expiresAt: shareForm.expiresAt,
      maxDownloads: shareForm.limitDownloads ? shareForm.maxDownloads : undefined,
      previewOnly: shareForm.previewOnly,
      watermarkText: shareForm.watermarkText.trim() || undefined,
      customPath: shareForm.customPath.trim() || undefined,
      allowedIps: parseAllowedIps(shareForm.allowedIpsText),
    });
    if (!current()) return;
    resetShareForm();
    await loadShares(fileId);
    if (!current()) return;
    await copyText(copyTarget === 'download' ? share.downloadUrl : share.url);
  } finally {
    if (current()) sharing.value = false;
  }
}

async function updateShare(): Promise<void> {
  if (!shareFile.value || !editingShareId.value) {
    return;
  }

  if (!validateShareForm(true)) {
    return;
  }
  const current = captureProjectContext();
  const fileId = shareFile.value.id;

  sharing.value = true;
  try {
    await fileApi.updateShare(editingShareId.value, {
      clearPassword: !shareForm.requiresPassword,
      password: shareForm.requiresPassword && shareForm.password ? shareForm.password : undefined,
      expiresAt: shareForm.expiresAt || null,
      maxDownloads: shareForm.limitDownloads ? shareForm.maxDownloads : null,
      enabled: shareForm.enabled,
      previewOnly: shareForm.previewOnly,
      watermarkText: shareForm.watermarkText.trim(),
      customPath: shareForm.customPath.trim(),
      allowedIps: parseAllowedIps(shareForm.allowedIpsText),
    });
    if (!current()) return;
    resetShareForm();
    ElMessage.success('分享链接已更新。');
    await loadShares(fileId);
  } finally {
    if (current()) sharing.value = false;
  }
}

function validateShareForm(isEditing: boolean): boolean {
  if (shareForm.requiresPassword && !isEditing && shareForm.password.length < 8) {
    ElMessage.warning('访问密码至少 8 位。');
    return false;
  }

  if (shareForm.requiresPassword && isEditing && shareForm.password && shareForm.password.length < 8) {
    ElMessage.warning('新访问密码至少 8 位。');
    return false;
  }

  if (shareForm.requiresPassword && isEditing && !editingShareHadPassword.value && shareForm.password.length < 8) {
    ElMessage.warning('请为该分享设置至少 8 位访问密码。');
    return false;
  }

  if (shareForm.limitDownloads && !shareForm.maxDownloads) {
    ElMessage.warning('请填写下载次数限制。');
    return false;
  }

  const customPath = shareForm.customPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (customPath) {
    if (customPath.length > 200) {
      ElMessage.warning('自定义分享后缀不能超过 200 个字符。');
      return false;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(customPath)) {
      ElMessage.warning('自定义分享后缀仅允许字母、数字、下划线、中划线与 /，且需以字母或数字开头。');
      return false;
    }
  }

  return true;
}

async function disableShare(shareId: string): Promise<void> {
  if (!shareFile.value) {
    return;
  }
  const current = captureProjectContext();
  const fileId = shareFile.value.id;

  await fileApi.disableShare(shareId);
  if (!current()) return;
  ElMessage.success('分享链接已停用。');
  await loadShares(fileId);
}

async function download(file: ManagedFile): Promise<void> {
  downloadingIds.value = new Set([...downloadingIds.value, file.id]);
  try {
    const { blob, source } = await fileApi.downloadWithSource(file.id);
    saveBlob(blob, file.originalName);
    downloadResults.value = [{ name: file.originalName, source, time: new Date().toLocaleString() }, ...downloadResults.value].slice(0, 20);
    if (source) ElMessage.success(`下载来源：${source.selected.configName}${source.selected.provider === 'LOCAL' ? '（本地兜底）' : ''}`);
  } finally {
    const nextIds = new Set(downloadingIds.value);
    nextIds.delete(file.id);
    downloadingIds.value = nextIds;
  }
}

async function batchDownload(): Promise<void> {
  const blob = await fileApi.batchDownload(selectedRows.value.map((file) => file.id));
  saveBlob(blob, `files-${Date.now()}.zip`);
}

async function recycle(file: ManagedFile): Promise<void> {
  if (!canManageFile(file)) {
    return;
  }

  await ElMessageBox.confirm('删除后文件会进入回收站，本地和云存储对象保留以便恢复。只有在回收站确认“彻底删除”后，才会删除全部存储副本，不会到期自动删除。', '删除文件', {
    type: 'warning',
    confirmButtonText: '确认删除',
    cancelButtonText: '取消',
  });
  await fileApi.remove(file.id);
  ElMessage.success('文件已移入回收站。');
  await reloadFirstPage();
}

async function batchRecycle(): Promise<void> {
  if (!canManageSelectedRows.value) {
    return;
  }

  await ElMessageBox.confirm(`确认删除选中的 ${selectedRows.value.length} 个文件？`, '批量删除', {
    type: 'warning',
    confirmButtonText: '确认删除',
    cancelButtonText: '取消',
  });
  await fileApi.batchRecycle(selectedRows.value.map((file) => file.id));
  ElMessage.success('已移入回收站。');
  await reloadFirstPage();
}

async function restore(file: ManagedFile): Promise<void> {
  if (!canManageFile(file)) {
    return;
  }

  await fileApi.restore(file.id);
  ElMessage.success('文件已恢复。');
  await reloadFirstPage();
}

async function batchRestore(): Promise<void> {
  if (!canManageSelectedRows.value) {
    return;
  }

  await fileApi.batchRestore(selectedRows.value.map((file) => file.id));
  ElMessage.success('文件已恢复。');
  await reloadFirstPage();
}

async function purge(file: ManagedFile): Promise<void> {
  if (!canManageFile(file)) {
    return;
  }

  await ElMessageBox.confirm('彻底删除会移除本地及云存储副本、历史版本和预览文件，操作不可恢复。若存储删除失败，将保留记录供重试。', '彻底删除', {
    type: 'warning',
    confirmButtonText: '彻底删除',
    cancelButtonText: '取消',
  });
  await fileApi.purge(file.id);
  ElMessage.success('文件已彻底删除。');
  await reloadFirstPage();
}






async function batchPurge(): Promise<void> {
  if (!canManageSelectedRows.value) {
    return;
  }

  await ElMessageBox.confirm(`确认彻底删除选中的 ${selectedRows.value.length} 个文件？`, '批量彻底删除', {
    type: 'warning',
    confirmButtonText: '彻底删除',
    cancelButtonText: '取消',
  });
  const result = await fileApi.batchPurge(selectedRows.value.map((file) => file.id));
  if (result.failed > 0) {
    ElMessage.warning(`成功 ${result.purged} 个，失败 ${result.failed} 个。`);
  } else {
    ElMessage.success('文件已彻底删除。');
  }
  await reloadFirstPage();
}

watch(() => uploadResults.files.map(file => `${file.id}:${file.currentVersion || 1}`).join('|'), () => { void loadUploadResultStorage(); }, { immediate: true });

watch(uploadStrategy, (value) => {
  if (value !== 'replace') {
    replaceTargetFileId.value = '';
    return;
  }
  if (selectedProjectId.value && replaceTargetOptions.value.length === 0) {
    void searchReplaceTargets('');
  }
});

watch(uploading, (active, previous) => {
  if (previous && !active && !uploadQueueState.canceled && uploadQueueState.projectId === selectedProjectId.value) {
    resetUploadVisibilityFilters();
    void reloadFirstPage();
  }
});

function resetProjectContext(): void {
  projectContextGeneration++;
  dialogReads.forEach(controller => controller.abort());
  dialogReads.clear();
  readController?.abort();
  targetController?.abort();
  readGeneration++;
  targetGeneration++;
  selectedRows.value = [];
  pageResult.items = [];
  pageResult.total = 0;
  pageResult.page = 1;
  filters.folderPath = '';
  folders.value = [];
  folderTree.value = [];
  folderPublicPaths.value = new Set();
  previewVisible.value = false;
  previewFile.value = null;
  contentFile.value = null;
  destroyHlsPlayer();
  versionsDialogVisible.value = false;
  versionsFile.value = null;
  versions.value = [];
  versionsLoading.value = false;
  storageDetailsVisible.value = false;
  storageDetailsFile.value = null;
  storageSummaryError.value = false;
  editDialogVisible.value = false;
  editingFile.value = null;
  moveDialogVisible.value = false;
  moveFile.value = null;
  shareDialogVisible.value = false;
  shareFile.value = null;
  shareLinks.value = [];
  pendingReplaceFileId.value = '';
  replaceTargetFileId.value = '';
  replaceTargetOptions.value = [];
  replaceTargetLoading.value = false;
  editing.value = false;
  sharing.value = false;
  moving.value = false;
  restoringVersion.value = null;
  ElMessageBox.close();
}

watch(selectedProjectId, () => {
  resetProjectContext();
  if (uploadStrategy.value === 'replace' && selectedProjectId.value) {
    void searchReplaceTargets('');
  }
}, { flush: 'sync' });

watch(
  () => [route.name, route.query.projectId, route.query.folderPath],
  async () => {
    const id = readRouteProjectId();
    if (selectedProjectId.value !== id) selectedProjectId.value = id;
    else resetProjectContext();
    filters.status = isRecycleBin.value
      ? 'RECYCLED'
      : 'ACTIVE';
    filters.folderPath = readRouteFolderPath();
    pageResult.page = 1;
    await reload();
  },
);

onMounted(async () => {
  void loadProjects();
  void reload();
  try {
    const settings = await settingsApi.list();
    officePreviewBaseUrl.value =
      typeof settings.officePreviewBaseUrl === 'string' ? settings.officePreviewBaseUrl : '';
  } catch {
    officePreviewBaseUrl.value = '';
  }
});

onBeforeUnmount(() => {
  uploadResultGeneration++;
  uploadResultController?.abort();
  globalThis.clearTimeout(uploadResultTimer);
  projectContextGeneration++;
  dialogReads.forEach(controller => controller.abort());
  dialogReads.clear();
  mountController.abort();
  readController?.abort();
  targetController?.abort();
  readGeneration++;
  targetGeneration++;
  destroyHlsPlayer();
});
</script>

<style scoped>
.upload-results {
  margin: 18px 0;
  padding: 16px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
}
.upload-results > p {
  font-size: 12px;
  line-height: 1.7;
}
.upload-results .el-pagination {
  margin-top: 12px;
}
.hidden-input {
  display: none;
}

.files-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.files-layout.has-folder {
  grid-template-columns: 200px minmax(0, 1fr);
}

.folder-pane {
  padding-inline-end: 16px;
  border-inline-end: 1px solid var(--color-border);
  background: var(--el-fill-color-blank);
}

.folder-toggle.el-button {
  display: none;
}

.folder-pane-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-weight: 600;
}

.folder-node {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding-inline-end: 4px;
}

.folder-count {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.files-main {
  min-width: 0;
  width: 100%;
}

.breadcrumb-row {
  margin-bottom: 10px;
}

@container admin-page (max-width: 50rem) {
  .files-layout,
  .files-layout.has-folder {
    grid-template-columns: minmax(0, 1fr);
  }
  .folder-pane {
    padding: 0 0 12px;
    border: 0;
    border-block-end: 1px solid var(--color-border);
  }
  .folder-pane-head {
    margin: 0;
  }
  .folder-pane-title {
    display: none;
  }
  .folder-toggle.el-button {
    display: inline-flex;
  }
  .folder-directory:not(.is-open) {
    display: none;
  }
  .folder-directory {
    padding-block-start: 12px;
  }
}

.filters {
  align-items: center;
}

.filter-project {
  width: 220px;
}

.filter-keyword {
  width: 220px;
}

.filter-tag {
  width: 140px;
}

.filter-ext {
  width: 120px;
}

.filter-select {
  width: 130px;
}

.table-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  max-width: 100%;
  white-space: normal;
}

.upload-options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.upload-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.drop-zone {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  padding: 16px 20px;
  margin-top: 12px;
  min-height: 82px;
  text-align: start;
  font-family: inherit;
  border: 1px dashed var(--el-border-color);
  border-radius: 10px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.drop-zone:not(:disabled):hover,
.drop-zone.is-dragging {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.drop-zone:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.drop-icon {
  font-size: 28px;
}

.drop-title {
  font-size: 14px;
  font-weight: 600;
}

.drop-subtitle {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.advanced-filters {
  margin-top: 10px;
}

.size-input {
  width: 150px;
}

.upload-progress {
  margin-top: 14px;
}

.data-table {
  margin-top: 14px;
}

.file-name {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 10px;
}

.thumb {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  object-fit: cover;
}

.file-main {
  min-width: 0;
}

.file-title {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.file-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
}

.tag-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pagination-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.share-panel {
  display: grid;
  gap: 18px;
}

.share-file-banner {
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: #f8fafc;
}

.share-file-name {
  font-weight: 600;
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.share-form-layout {
  display: grid;
  gap: 14px;
}

.share-form-section {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: #ffffff;
}

.share-form-section-title {
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 700;
  color: #334155;
  letter-spacing: 0.02em;
}

.share-form-grid {
  display: grid;
  gap: 4px 16px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.share-form-grid-wide {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.share-form-span-2 {
  grid-column: 1 / -1;
}

.share-form-input {
  margin-top: 8px;
  width: 100%;
}

.share-form-hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.4;
}

.share-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.share-list-block {
  display: grid;
  gap: 10px;
}

.share-list-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.share-list-header .share-form-section-title {
  margin-bottom: 0;
}

.share-links-cell {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.share-links-cell .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-limit {
  display: grid;
  gap: 2px;
  color: #475569;
  font-size: 12px;
}

.full-input {
  width: 100%;
}

.preview-frame {
  display: grid;
  min-height: 60vh;
  place-items: center;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-muted);
}

.preview-frame img,
.preview-frame video,
.preview-frame iframe {
  width: 100%;
  max-height: 70vh;
  border: 0;
  object-fit: contain;
}

.preview-frame iframe {
  min-height: 70vh;
  background: #ffffff;
}

.preview-video {
  width: 100%;
  max-height: 70vh;
  background: #000;
}

.preview-hint {
  margin-top: 8px;
  font-size: 12px;
}

.office-preview-fallback {
  display: grid;
  gap: 10px;
  place-items: center;
  width: 100%;
  padding: 16px;
  text-align: center;
}

.office-iframe {
  width: 100%;
  min-height: 70vh;
  border: 0;
  background: #fff;
}

.version-current-tag {
  margin-left: 6px;
}

@container admin-page (max-width: 50rem) {
  .share-form-grid,
  .share-form-grid-wide {
    grid-template-columns: 1fr;
  }
}

.file-search .filters {
  gap: 10px;
}
.file-search .filter-keyword {
  width: auto;
  flex: 1 1 180px;
}
.file-search .filter-project {
  width: 220px;
  max-width: 100%;
}
.file-search-button.el-button {
  padding-inline: 12px;
}
.file-refresh-button.el-button {
  width: 34px;
  flex: none;
  padding: 0;
}
.file-search .advanced-filters {
  margin-top: 14px;
  border-bottom: 0;
}
.file-search :deep(.el-collapse-item__header) {
  min-height: 30px;
  height: auto;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.file-search :deep(.el-collapse-item__wrap) {
  border-bottom: 0;
}
.file-search :deep(.el-collapse-item__content) {
  padding-bottom: 0;
  padding-top: 12px;
}
.file-search :deep(.el-date-editor) {
  max-width: 100%;
}
.folder-toggle.el-button {
  gap: 6px;
  height: auto;
  min-height: 36px;
  padding-inline: 0;
}
.folder-toggle .expanded {
  transform: rotate(180deg);
}
.folder-toggle :deep(> span) {
  gap: 6px;
}
.folder-pane-title {
  font-size: 13px;
}
.folder-hint {
  margin-block: 20px 0;
  font-size: 11px;
  line-height: 1.7;
}
.folder-node {
  min-width: 0;
  align-items: center;
}
.folder-node > span:first-child {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.folder-pane :deep(.el-tree-node__content) {
  min-height: 36px;
  height: auto;
}
.folder-pane :deep(.el-tree) {
  --el-tree-node-content-height: 36px;
}
.folder-node .el-button {
  min-width: 24px;
  min-height: 24px;
}
.file-list-heading {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-block-start: 16px;
}
.file-list-heading > div {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.file-list-heading h2 {
  font-size: 15px;
  margin: 0;
  font-weight: 650;
}
.file-list-heading span {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.file-bulk-actions {
  margin-block-start: 14px;
  padding: 12px;
  background: var(--color-primary-soft);
  border-radius: var(--radius-control);
}
.files-error {
  margin-block-start: 12px;
}
.upload-settings {
  border-top: 0;
}
.upload-settings :deep(.el-collapse-item__header) {
  height: auto;
  min-height: 34px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.upload-settings :deep(.el-collapse-item__content) {
  padding-bottom: 14px;
}
.upload-strategy {
  width: min(100%, 320px);
}
.upload-replace-target {
  width: min(100%, 360px);
}
.upload-options {
  margin-top: 6px;
}
.drop-copy {
  display: grid;
  gap: 5px;
}
.table-scroll-hint {
  margin-block: 10px 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.drop-title {
  line-height: 1.5;
}
.drop-subtitle {
  line-height: 1.5;
}
.files-main .breadcrumb-row {
  overflow-x: auto;
}
.files-main .el-breadcrumb {
  display: flex;
  width: max-content;
  max-width: 100%;
  flex-wrap: wrap;
  row-gap: 6px;
  line-height: 1.5;
}
.pagination-row {
  flex-wrap: wrap;
  gap: 8px;
}
@container admin-page (max-width: 30rem) {
  .file-search .filter-project {
    width: 100%;
  }
  .file-search .filter-keyword {
    flex-basis: 110px;
  }
  .drop-zone {
    padding: 14px;
    gap: 12px;
  }
  .pagination-row {
    justify-content: flex-start;
  }
}
</style>
