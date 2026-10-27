<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">{{ pageTitle }}</h1>
        <p class="page-subtitle">{{ pageSubtitle }}</p>
      </div>
      <div class="toolbar">
        <input ref="fileInputRef" type="file" multiple class="hidden-input" @change="handleFileChange" />
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
          :disabled="!selectedProjectId"
          @click="fileInputRef?.click()"
        >
          上传文件
        </el-button>
        <el-button
          v-if="!isRecycleBin && canManageSelectedProject"
          :icon="Upload"
          :disabled="!selectedProjectId"
          @click="folderInputRef?.click()"
        >
          上传文件夹
        </el-button>
        <el-button
          v-if="!isRecycleBin && canManageSelectedProject"
          :icon="FolderAdd"
          :disabled="!selectedProjectId"
          @click="createFolder"
        >
          新建文件夹
        </el-button>
        <el-button
          v-if="!isRecycleBin && canManageSelectedProject"
          :icon="Refresh"
          :loading="migratingLocalFiles"
          :disabled="!selectedProjectId"
          @click="migrateLocalFiles"
        >
          迁移本地文件
        </el-button>
        <el-button v-if="!isRecycleBin" :icon="Download" :disabled="selectedRows.length === 0" @click="batchDownload">
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
        <el-button v-if="isRecycleBin" :icon="Back" @click="goFiles">返回文件管理</el-button>
      </div>
    </div>

    <section class="surface">
      <div class="surface-body files-layout" :class="{ 'has-folder': showFolderPane }">
        <aside v-if="showFolderPane" class="folder-pane">
          <div class="folder-pane-head">
            <span>目录</span>
            <el-button link type="primary" @click="selectFolder('')">根目录</el-button>
          </div>
          <el-tree
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
                <el-tag v-if="isFolderPublic(data.path)" size="small" type="success" effect="plain">公开</el-tag>
                <span class="folder-count">{{ data.fileCount }}</span>
                <el-dropdown
                  v-if="canManageSelectedProject"
                  trigger="click"
                  @command="(cmd: string) => handleFolderCommand(cmd, data.path)"
                >
                  <el-button link type="primary" size="small" @click.stop>⋯</el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
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
        </aside>

        <div class="files-main">
        <div v-if="showFolderPane" class="breadcrumb-row">
          <el-breadcrumb separator="/">
            <el-breadcrumb-item>
              <a href="javascript:;" @click.prevent="selectFolder('')">根目录</a>
            </el-breadcrumb-item>
            <el-breadcrumb-item v-for="seg in folderBreadcrumbs" :key="seg.path">
              <a href="javascript:;" @click.prevent="selectFolder(seg.path)">{{ seg.name }}</a>
            </el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="toolbar filters">
          <el-select
            v-model="selectedProjectId"
            filterable
            clearable
            placeholder="全部项目"
            class="filter-project"
            @change="handleProjectFilterChange"
          >
            <el-option label="全部项目" value="" />
            <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id" />
          </el-select>
          <el-input
            v-model="filters.keyword"
            clearable
            placeholder="文件名、备注、标签"
            class="filter-keyword"
            :prefix-icon="Search"
            @keyup.enter="reloadFirstPage"
            @clear="reloadFirstPage"
          />
          <el-input
            v-model="filters.tag"
            clearable
            placeholder="标签"
            class="filter-tag"
            @keyup.enter="reloadFirstPage"
          />
          <el-input
            v-model="filters.extension"
            clearable
            placeholder="扩展名"
            class="filter-ext"
            @keyup.enter="reloadFirstPage"
          />
          <el-select
            v-model="filters.category"
            clearable
            placeholder="类型"
            class="filter-select"
            @change="reloadFirstPage"
          >
            <el-option v-for="item in categoryOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-select
            v-model="filters.cdnProvider"
            clearable
            placeholder="存储"
            class="filter-select"
            @change="reloadFirstPage"
          >
            <el-option label="本地" value="LOCAL" />
            <el-option label="七牛" value="QINIU" />
            <el-option label="又拍" value="UPYUN" />
            <el-option label="阿里" value="ALIYUN" />
            <el-option label="S3" value="S3" />
          </el-select>
          <el-checkbox v-model="filters.duplicateOnly" @change="reloadFirstPage">重复文件</el-checkbox>
          <el-button :icon="Refresh" @click="reload">刷新</el-button>
        </div>

        <div v-if="!isRecycleBin && canManageSelectedProject" class="upload-options">
          <el-select v-model="uploadStrategy" style="width: 320px">
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
            style="width: 360px"
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
                ? '覆盖指定记录：fileId/直链/分享不变；即使上传不同文件名也会覆盖并更新名称'
                : uploadStrategy === 'replace'
                  ? '按同名+当前目录覆盖；行内「上传覆盖」可对不同文件名强制覆盖并改名'
                  : uploadStrategy === 'reuse'
                    ? '内容相同则直接返回已有文件'
                    : '内容重复时拒绝上传'
            }}
          </span>
        </div>

        <div
          v-if="!isRecycleBin && canManageSelectedProject"
          class="drop-zone"
          :class="{ 'is-dragging': isDragging, 'is-disabled': !selectedProjectId || uploading }"
          @dragenter.prevent="handleDragEnter"
          @dragover.prevent="handleDragOver"
          @dragleave.prevent="handleDragLeave"
          @drop.prevent="handleDrop"
          @click="selectedProjectId && !uploading && fileInputRef?.click()"
        >
          <el-icon class="drop-icon"><Upload /></el-icon>
          <div class="drop-title">拖拽文件到此处上传</div>
          <div class="drop-subtitle">
            {{ selectedProjectId ? '也可点击选择文件；支持多文件' : '请先选择项目' }}
          </div>
        </div>

        <el-collapse class="advanced-filters">
          <el-collapse-item title="高级过滤" name="advanced">
            <div class="toolbar">
              <el-input-number
                v-model="filters.minSizeMb"
                :min="0"
                :precision="1"
                controls-position="right"
                placeholder="最小 MB"
                class="size-input"
              />
              <el-input-number
                v-model="filters.maxSizeMb"
                :min="0"
                :precision="1"
                controls-position="right"
                placeholder="最大 MB"
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

        <el-progress v-if="!isRecycleBin && uploading" :percentage="uploadProgress" class="upload-progress" />

        <el-table
          v-loading="loading"
          :data="pageResult.items"
          row-key="id"
          class="data-table"
          @selection-change="handleSelectionChange"
        >
          <el-table-column type="selection" width="48" />
          <el-table-column prop="originalName" label="文件名" min-width="300" show-overflow-tooltip>
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
          <el-table-column v-if="!selectedProjectId" label="项目" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">
              {{ row.projectName || row.projectId }}
            </template>
          </el-table-column>
          <el-table-column label="标签" min-width="160">
            <template #default="{ row }">
              <div class="tag-line">
                <el-tag v-for="tag in row.tags" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
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
          <el-table-column v-if="isRecycleBin" label="到期清理" width="160">
            <template #default="{ row }">
              <span v-if="row.purgeAt">{{ formatPurgeCountdown(row.purgeAt) }}</span>
              <span v-else class="muted">-</span>
            </template>
          </el-table-column>
          <el-table-column label="存储位置" min-width="150">
            <template #default="{ row }">
              <el-tag effect="dark" type="info">{{ row.storageConfigName || row.cdnProvider || '未知存储' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="isRecycleBin ? '删除时间' : '上传时间'" min-width="170">
            <template #default="{ row }">
              {{ formatTime(isRecycleBin ? row.deletedAt || row.updatedAt : row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" min-width="280" width="300">
            <template #default="{ row }">
              <div class="table-actions">
                <template v-if="!isRecycleBin">
                  <el-button link type="primary" :disabled="!row.previewable" @click="openPreview(row)">预览</el-button>
                  <el-button link type="primary" :loading="downloadingIds.has(row.id)" @click="download(row)">
                    下载
                  </el-button>
                  <el-button v-if="canManageFile(row)" link type="primary" @click="openStorageCopy(row)">复制到存储</el-button>
                  <el-button v-if="canManageFile(row)" link type="primary" @click="openEditDialog(row)">
                    编辑
                  </el-button>
                  <el-button v-if="canManageFile(row)" link type="primary" @click="openShareDialog(row)">
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

    <el-dialog
      v-model="storageCopyVisible"
      title="复制文件到其他存储"
      width="520px"
      align-center
      append-to-body
      destroy-on-close
    >
      <el-alert type="info" :closable="false" show-icon title="复制成功后文件归属切换到目标存储，源对象会保留。" />
      <el-select v-model="storageCopyTargetId" placeholder="请选择目标存储" style="width: 100%; margin-top: 16px">
        <el-option
          v-for="config in storageCopyConfigs.filter((item) => item.id !== storageCopyFile?.storageConfigId)"
          :key="config.id"
          :label="`${config.name}（${config.provider}）`"
          :value="config.id"
        />
      </el-select>
      <template #footer>
        <el-button @click="storageCopyVisible = false">取消</el-button>
        <el-button type="primary" :loading="storageCopyLoading" :disabled="!storageCopyTargetId" @click="submitStorageCopy">开始复制</el-button>
      </template>
    </el-dialog>

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
            <el-table-column label="操作" width="220" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="copyText(row.url)">复制</el-button>
                <el-button link type="primary" @click="copyText(row.downloadUrl)">直链</el-button>
                <el-button link type="primary" @click="editShare(row)">编辑</el-button>
                <el-button v-if="row.enabled" link type="danger" @click="disableShare(row.id)">停用</el-button>
              </template>
            </el-table-column>
          </el-table>
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
        <el-table-column label="操作" width="100" fixed="right">
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
      <template #footer>
        <el-button @click="versionsDialogVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { Back, Delete, Document, Download, FolderAdd, Refresh, Search, Upload } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { http } from '@/api/http';
import { cdnApi, fileApi, folderPublicApi, projectApi, settingsApi, uploadCredentialApi } from '@/api/modules';
import type { CdnConfig, CdnProvider, FileCategory, FileStatus, ManagedFile, PageResult, Project, ShareLink, ShareStatus } from '@/types';
import { copyText, saveBlob } from '@/utils/io';

type FileListParams = Parameters<typeof fileApi.list>[0];

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const uploading = ref(false);
const editing = ref(false);
const sharing = ref(false);
const moving = ref(false);
const migratingLocalFiles = ref(false);
const uploadProgress = ref(0);
const isDragging = ref(false);
const dragDepth = ref(0);
const uploadStrategy = ref<'reject' | 'reuse' | 'replace'>('reject');
const replaceTargetFileId = ref('');
const replaceFileInputRef = ref<HTMLInputElement | null>(null);
const pendingReplaceFileId = ref('');
const replaceTargetLoading = ref(false);
const replaceTargetOptions = ref<ManagedFile[]>([]);
const projects = ref<Project[]>([]);
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
    ? '查看已删除文件，可在保留期内恢复，或执行不可恢复的彻底删除。'
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
const fileInputRef = ref<HTMLInputElement>();
const folderInputRef = ref<HTMLInputElement>();
const previewVisible = ref(false);
const previewFile = ref<ManagedFile | null>(null);
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
const storageCopyVisible = ref(false);
const storageCopyLoading = ref(false);
const storageCopyTargetId = ref('');
const storageCopyFile = ref<ManagedFile | null>(null);
const storageCopyConfigs = ref<CdnConfig[]>([]);
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
  folderPath: '',
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

function formatPurgeCountdown(value?: string | null): string {
  if (!value) {
    return '-';
  }
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) {
    return '-';
  }
  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    return '即将清理';
  }
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) {
    return `${days} 天后`;
  }
  if (hours > 0) {
    return `${hours} 小时后`;
  }
  return '不到 1 小时';
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
  projects.value = await projectApi.list();
  syncSelectedProjectFromRoute();
  await reload();
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

async function reloadFirstPage(): Promise<void> {
  pageResult.page = 1;
  await reload();
}

async function handleProjectFilterChange(): Promise<void> {
  filters.folderPath = '';
  await reloadFirstPage();
}

async function reload(): Promise<void> {
  selectedRows.value = [];
  filters.status = isRecycleBin.value ? 'RECYCLED' : 'ACTIVE';
  void router.replace({
    path: route.path,
    query: selectedProjectId.value ? { projectId: selectedProjectId.value } : {},
  });
  loading.value = true;
  try {
    const [result, folderResult, treeResult, publicPolicies] = await Promise.all([
      loadVisibleFiles(),
      selectedProjectId.value && !isRecycleBin.value
        ? fileApi.listFolders(selectedProjectId.value)
        : Promise.resolve([]),
      selectedProjectId.value && !isRecycleBin.value
        ? fileApi.listFolderTree(selectedProjectId.value)
        : Promise.resolve([]),
      selectedProjectId.value && !isRecycleBin.value
        ? folderPublicApi.list(selectedProjectId.value).catch(() => [])
        : Promise.resolve([]),
    ]);
    pageResult.items = result.items;
    pageResult.total = result.total;
    pageResult.page = result.page;
    pageResult.pageSize = result.pageSize;
    folders.value = folderResult;
    folderTree.value = treeResult as Array<{ name: string; path: string; fileCount: number; children: unknown[] }>;
    folderPublicPaths.value = new Set(
      (publicPolicies as Array<{ folderPath: string; isPublic: boolean }>)
        .filter((item) => item.isPublic)
        .map((item) => item.folderPath || ''),
    );
  } finally {
    loading.value = false;
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
      : '已取消公开：仅授权域名或签名链接可访问。',
  );
  await reload();
}

function copyPublicUrl(file: ManagedFile): void {
  const base = window.location.origin.replace(/\/$/, '');
  // Stable fileId-based path. Domain policy is enforced by the public endpoint:
  // public files are open; non-public files only from authorized domains / signed links.
  const url = file.accessUrl || file.publicUrl || `${base}/api/public/files/${file.id}`;
  void copyText(String(url));
  ElMessage.success(file.isPublic ? '公开直链已复制（任意域名可访问）。' : '直链已复制（授权域名可访问；未公开）。');
}

async function loadVisibleFiles(): Promise<PageResult<ManagedFile>> {
  return fileApi.list(buildListParams(selectedProjectId.value || undefined, pageResult.page, pageResult.pageSize));
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
    selectedProjectId.value && !isRecycleBin.value
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
  if (!selectedProjectId.value || !canManageSelectedProject.value) {
    replaceTargetOptions.value = [];
    return;
  }
  replaceTargetLoading.value = true;
  try {
    const result = await fileApi.list({
      projectId: selectedProjectId.value,
      keyword: keyword?.trim() || undefined,
      status: 'ACTIVE',
      page: 1,
      pageSize: 30,
    });
    replaceTargetOptions.value = result.items;
  } finally {
    replaceTargetLoading.value = false;
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
  versionsLoading.value = true;
  versions.value = [];
  try {
    versions.value = await fileApi.listVersions(file.id);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载版本历史失败。');
    versionsDialogVisible.value = false;
  } finally {
    versionsLoading.value = false;
  }
}

async function restoreFileVersion(version: number): Promise<void> {
  if (!versionsFile.value) {
    return;
  }
  const file = versionsFile.value;
  try {
    await ElMessageBox.confirm(
      `确认将「${file.originalName}」恢复到版本 v${version}？当前内容会先归档为新历史版本。`,
      '恢复历史版本',
      { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }

  restoringVersion.value = version;
  try {
    await fileApi.restoreVersion(file.id, version);
    ElMessage.success(`已恢复到版本 v${version}。`);
    versionsDialogVisible.value = false;
    await reload();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复版本失败。');
  } finally {
    restoringVersion.value = null;
  }
}

async function uploadFiles(
  files: File[],
  override?: {
    duplicateStrategy?: 'reject' | 'reuse' | 'replace';
    targetFileId?: string;
  },
): Promise<void> {
  if (!selectedProjectId.value || !canManageSelectedProject.value || files.length === 0) {
    return;
  }

  const projectId = selectedProjectId.value;
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
      const uploaded = await fileApi.upload(projectId, formData, {
        folderPath: filters.folderPath,
        duplicateStrategy,
        targetFileId,
        onUploadProgress: (progress) => {
          uploadProgress.value = Math.round(((doneCount + (progress / 100) * smallFiles.length) / totalCount) * 100);
        },
      });
      if (Array.isArray(uploaded)) {
        reusedCount += uploaded.filter((item) => item.duplicateReused).length;
        if (targetFileId && uploaded[0]?.originalName) {
          overwriteNewName = String(uploaded[0].originalName);
        }
      }
      doneCount += smallFiles.length;
      uploadProgress.value = Math.round((doneCount / totalCount) * 100);
    }

    for (const file of largeFiles) {
      const uploaded = await uploadCredentialApi.uploadDirectOrResumable(projectId, file, {
        folderPath: filters.folderPath,
        duplicateStrategy,
        targetFileId,
        onProgress: (progress) => {
          uploadProgress.value = Math.round(((doneCount + progress / 100) / totalCount) * 100);
        },
      });
      if (uploaded?.duplicateReused) {
        reusedCount += 1;
      }
      if (targetFileId && uploaded && typeof uploaded === 'object' && 'originalName' in uploaded && uploaded.originalName) {
        overwriteNewName = String(uploaded.originalName);
      }
      doneCount += 1;
      uploadProgress.value = Math.round((doneCount / totalCount) * 100);
    }

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
    resetUploadVisibilityFilters();
    await reloadFirstPage();
  } finally {
    uploading.value = false;
  }
}

async function openStorageCopy(file: ManagedFile): Promise<void> {
  if (!canManageFile(file)) return;
  storageCopyFile.value = file;
  storageCopyTargetId.value = '';
  storageCopyConfigs.value = await cdnApi.list(file.projectId);
  storageCopyVisible.value = true;
}

async function submitStorageCopy(): Promise<void> {
  const file = storageCopyFile.value;
  if (!file || !storageCopyTargetId.value) return;
  storageCopyLoading.value = true;
  try {
    await fileApi.copyToStorage(file.id, storageCopyTargetId.value);
    ElMessage.success('文件已复制到目标存储，源存储中的对象已保留。');
    storageCopyVisible.value = false;
    await reload();
  } finally {
    storageCopyLoading.value = false;
  }
}

async function createFolder(): Promise<void> {
  if (!selectedProjectId.value || !canManageSelectedProject.value) {
    return;
  }

  const { value } = await ElMessageBox.prompt('请输入目录路径（可包含多级，如 contracts/2026）', '新建文件夹', {
    confirmButtonText: '创建',
    cancelButtonText: '取消',
    inputPattern: /^[^\\:*?"<>|]+$/,
    inputErrorMessage: '目录名不能包含 \\ : * ? " < > |',
  });

  const folderPath = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!folderPath) {
    ElMessage.warning('目录名不能为空。');
    return;
  }

  await fileApi.createFolder(selectedProjectId.value, folderPath);
  ElMessage.success('目录已创建。');
  await reload();
}
async function migrateLocalFiles(): Promise<void> {
  if (!selectedProjectId.value || !canManageSelectedProject.value) {
    return;
  }

  await ElMessageBox.confirm(
    '会把当前项目仍在本地存储的文件上传到当前启用的云存储，并把文件记录切换到新存储。本地原文件会保留。',
    '迁移本地文件',
    {
      type: 'warning',
      confirmButtonText: '开始迁移',
      cancelButtonText: '取消',
    },
  );

  migratingLocalFiles.value = true;
  try {
    const result = await fileApi.migrateLocalFiles(selectedProjectId.value);
    const message = `扫描 ${result.scanned} 个本地文件，成功 ${result.migrated} 个，失败 ${result.failed} 个。`;
    if (result.failed > 0) {
      ElMessage.warning(message);
    } else if (result.migrated > 0) {
      ElMessage.success(message);
    } else {
      ElMessage.info('当前项目没有需要迁移的本地文件。');
    }
    filters.cdnProvider = '';
    await reloadFirstPage();
  } finally {
    migratingLocalFiles.value = false;
  }
}

function openPreview(file: ManagedFile): void {
  destroyHlsPlayer();
  previewFile.value = file;
  previewVisible.value = true;
  if (file.category === 'VIDEO' && file.hlsUrl) {
    void nextTick(() => attachHlsPlayer(file));
  }
}

function previewSource(file: ManagedFile): string {
  return fileAccessSource(file.accessUrl);
}

function previewVideoSource(file: ManagedFile & { progressiveUrl?: string | null; hlsUrl?: string | null }): string {
  return fileAccessSource(file.progressiveUrl || file.accessUrl);
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
        ElMessage.success('文件已移动。');
      } else {
        const result = await fileApi.batchCopy(
          selectedRows.value.map((file) => file.id),
          moveForm.folderPath || null,
          moveForm.projectId || undefined,
        );
        if (result.failed > 0) {
          ElMessage.warning(`复制成功 ${result.copied} 个，失败 ${result.failed} 个。`);
        } else {
          ElMessage.success('文件已复制。');
        }
      }
    } else if (moveFile.value) {
      if (moveMode.value === 'move') {
        await fileApi.move(moveFile.value.id, { folderPath: moveForm.folderPath || null });
        ElMessage.success('文件已移动。');
      } else {
        await fileApi.copy(moveFile.value.id, {
          projectId: moveForm.projectId || moveFile.value.projectId,
          folderPath: moveForm.folderPath || null,
        });
        ElMessage.success('文件已复制。');
      }
    }

    moveDialogVisible.value = false;
    await reload();
  } finally {
    moving.value = false;
  }
}

async function submitEdit(): Promise<void> {
  if (!editingFile.value) {
    return;
  }

  editing.value = true;
  try {
    await fileApi.update(editingFile.value.id, {
      originalName: editForm.originalName,
      folderPath: editForm.folderPath,
      tags: readTagList(editForm.tags),
      remark: editForm.remark,
      isPublic: editForm.isPublic,
    });
    editDialogVisible.value = false;
    ElMessage.success('文件信息已更新。');
    await reload();
  } finally {
    editing.value = false;
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
  shareLinks.value = await fileApi.listShares(fileId);
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

  sharing.value = true;
  try {
    const copyTarget = shareForm.copyTarget;
    const share = await fileApi.createShare(shareFile.value.id, {
      password: shareForm.requiresPassword ? shareForm.password : undefined,
      expiresAt: shareForm.expiresAt,
      maxDownloads: shareForm.limitDownloads ? shareForm.maxDownloads : undefined,
      previewOnly: shareForm.previewOnly,
      watermarkText: shareForm.watermarkText.trim() || undefined,
      customPath: shareForm.customPath.trim() || undefined,
      allowedIps: parseAllowedIps(shareForm.allowedIpsText),
    });
    resetShareForm();
    await loadShares(shareFile.value.id);
    await copyText(copyTarget === 'download' ? share.downloadUrl : share.url);
  } finally {
    sharing.value = false;
  }
}

async function updateShare(): Promise<void> {
  if (!shareFile.value || !editingShareId.value) {
    return;
  }

  if (!validateShareForm(true)) {
    return;
  }

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
    resetShareForm();
    ElMessage.success('分享链接已更新。');
    await loadShares(shareFile.value.id);
  } finally {
    sharing.value = false;
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

  await fileApi.disableShare(shareId);
  ElMessage.success('分享链接已停用。');
  await loadShares(shareFile.value.id);
}

async function download(file: ManagedFile): Promise<void> {
  downloadingIds.value = new Set([...downloadingIds.value, file.id]);
  try {
    const blob = await fileApi.download(file.id);
    saveBlob(blob, file.originalName);
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

  await ElMessageBox.confirm('删除后文件会进入回收站，可在保留期内恢复。', '删除文件', {
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

  await ElMessageBox.confirm('彻底删除会移除存储对象，操作不可恢复。', '彻底删除', {
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

watch(uploadStrategy, (value) => {
  if (value !== 'replace') {
    replaceTargetFileId.value = '';
    return;
  }
  if (selectedProjectId.value && replaceTargetOptions.value.length === 0) {
    void searchReplaceTargets('');
  }
});

watch(selectedProjectId, () => {
  replaceTargetFileId.value = '';
  replaceTargetOptions.value = [];
  if (uploadStrategy.value === 'replace' && selectedProjectId.value) {
    void searchReplaceTargets('');
  }
});

watch(
  () => route.name,
  async () => {
    filters.status = isRecycleBin.value
      ? 'RECYCLED'
      : 'ACTIVE';
    pageResult.page = 1;
    await reload();
  },
);

watch(
  () => route.query.projectId,
  async () => {
    const routeProjectId = readRouteProjectId();

    if (routeProjectId && routeProjectId !== selectedProjectId.value) {
      selectedProjectId.value = routeProjectId;
      pageResult.page = 1;
      await reload();
      return;
    }

    if (!routeProjectId && selectedProjectId.value) {
      selectedProjectId.value = '';
      pageResult.page = 1;
      await reload();
    }
  },
);

onMounted(async () => {
  await loadProjects();
  try {
    const settings = await settingsApi.list();
    officePreviewBaseUrl.value =
      typeof settings.officePreviewBaseUrl === 'string' ? settings.officePreviewBaseUrl : '';
  } catch {
    officePreviewBaseUrl.value = '';
  }
});

onBeforeUnmount(() => {
  destroyHlsPlayer();
});
</script>

<style scoped>
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
  grid-template-columns: 240px minmax(0, 1fr);
}

.folder-pane {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  padding: 10px;
  min-height: 360px;
  background: var(--el-fill-color-blank);
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
  padding-right: 4px;
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

@media (max-width: 960px) {
  .files-layout,
  .files-layout.has-folder {
    grid-template-columns: 1fr;
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 12px;
  min-height: 120px;
  border: 1px dashed var(--el-border-color);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.drop-zone:hover,
.drop-zone.is-dragging {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.drop-zone.is-disabled {
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

@media (max-width: 900px) {
  .share-form-grid,
  .share-form-grid-wide {
    grid-template-columns: 1fr;
  }
}
</style>
