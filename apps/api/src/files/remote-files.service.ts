import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UserRole } from '@prisma/client';
import type { StorageRemoteFile, StorageRemotePage } from '@ufm/storage-plugin-sdk';

import { BackupService } from '../backup/backup.service';
import type { RequestUser } from '../common/types/request-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { SettingsService } from '../settings/settings.service';
import { StorageAdapterRegistry } from '../storage/storage-registry.service';
import { StorageService } from '../storage/storage.service';
import type { RuntimeCdnConfig, StorageAdapter } from '../storage/storage.types';
import type { ImportRemoteFilesDto, ListRemoteFilesDto } from './dto/remote-files.dto';
import { FilesService } from './files.service';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,191}$/;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS = 2000;
const JOB_RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_JOBS = 128;
const MAX_READY_DOWNLOADS_PER_USER = 3;

/** Only host-authored messages from this class may appear in per-file errors. */
class RemoteFileError extends HttpException {
  constructor(message: string, status = 400, cause?: unknown) {
    super(message, status, { cause });
  }
}

type RemoteContext = { config: RuntimeCdnConfig; adapter: StorageAdapter };
type StagedRemoteFile = { root: string; path: string; name: string; mimeType: string; size: number };
export type RemoteFileImportResult = {
  imported: number;
  failed: number;
  items: Array<{ id: string; name: string; status: 'IMPORTED' | 'FAILED'; fileId?: string; projectId?: string; error?: string }>;
};
export type RemoteFileDownload = {
  name: string;
  size: number;
  mimeType: string;
  stream: Readable;
  cleanup: () => Promise<void>;
};
export type RemoteTransferStatus = {
  id: string;
  kind: 'IMPORT' | 'DOWNLOAD';
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  result?: RemoteFileImportResult;
  name?: string;
  size?: number;
  error?: string;
};
type RemoteTransferJob = RemoteTransferStatus & {
  userId: string; configId: string; expiresAt?: number;
  download?: RemoteFileDownload; timer?: NodeJS.Timeout; controller: AbortController; work?: Promise<void>;
};

@Injectable()
export class RemoteFilesService implements OnModuleDestroy {
  private readonly activeUsers = new Set<string>();
  private readonly snapshots = new Map<string, { file: StorageRemoteFile; expiresAt: number }>();
  private readonly jobs = new Map<string, RemoteTransferJob>();
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: StorageAdapterRegistry,
    private readonly storageService: StorageService,
    private readonly filesService: FilesService,
    private readonly backupService: BackupService,
    private readonly projectAccessService: ProjectAccessService,
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
  ) {}

  async startImportJob(configId: string, dto: ImportRemoteFilesDto, user: RequestUser): Promise<RemoteTransferStatus> {
    this.assertAdmin(user);
    this.assertId(configId);
    this.validateImport(dto);
    await this.sweepJobs();
    const job = this.newJob(configId, user, 'IMPORT');
    // import() acquires the shared user slot synchronously, before its first
    // await. The wrapper must not acquire that slot a second time.
    job.work = this.import(configId, dto, user, job.controller.signal).then(result => {
      if (this.stopping || !this.jobs.has(job.id)) return;
      job.result = result;
      this.finishJob(job);
    }, error => this.failJob(job, error));
    return this.jobStatus(job);
  }

  async startDownloadJob(configId: string, fileId: string, user: RequestUser): Promise<RemoteTransferStatus> {
    this.assertAdmin(user);
    this.assertId(configId);
    this.assertId(fileId);
    await this.sweepJobs();
    const job = this.newJob(configId, user, 'DOWNLOAD');
    job.work = this.download(configId, fileId, user, job.controller.signal, true).then(async download => {
      if (this.stopping || !this.jobs.has(job.id)) { await download.cleanup(); return; }
      job.download = download;
      job.name = download.name;
      job.size = download.size;
      this.finishJob(job);
    }, error => this.failJob(job, error)).catch(() => undefined);
    return this.jobStatus(job);
  }

  async getJob(configId: string, jobId: string, user: RequestUser): Promise<RemoteTransferStatus> {
    this.assertAdmin(user);
    this.assertId(configId);
    this.assertId(jobId);
    await this.sweepJobs();
    return this.jobStatus(this.ownedJob(configId, jobId, user));
  }

  async takeDownload(configId: string, jobId: string, user: RequestUser): Promise<RemoteFileDownload> {
    this.assertAdmin(user);
    this.assertId(configId);
    this.assertId(jobId);
    await this.sweepJobs();
    const job = this.ownedJob(configId, jobId, user);
    if (job.kind !== 'DOWNLOAD' || job.status !== 'SUCCEEDED' || !job.download) throw new ConflictException('云端文件尚未就绪，请等待校验完成。');
    // Claim before returning the stream. A second HTTP request cannot consume it.
    this.jobs.delete(job.id);
    if (job.timer) clearTimeout(job.timer);
    return job.download;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    await Promise.all(jobs.map(async job => {
      job.controller.abort();
      if (job.timer) clearTimeout(job.timer);
      await job.download?.cleanup().catch(() => undefined);
    }));
    // A pipeline aborted above needs an event-loop turn to close descriptors and
    // remove its directory. Do not wait indefinitely on a plugin HTTP request.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(jobs.flatMap(job => job.work ? [job.work] : [])),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 4000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private newJob(configId: string, user: RequestUser, kind: RemoteTransferJob['kind']): RemoteTransferJob {
    if (this.stopping) throw new RemoteFileError('服务正在重新启动，请稍后重试。', 503);
    if (this.activeUsers.has(user.id)) throw new ConflictException('已有云端文件任务正在处理中，请等待完成后重试。');
    if (kind === 'DOWNLOAD' && [...this.jobs.values()].filter(job => job.userId === user.id && job.kind === 'DOWNLOAD' && job.status !== 'FAILED').length >= MAX_READY_DOWNLOADS_PER_USER) {
      throw new RemoteFileError('已有 3 个文件等待保存，请先保存已就绪文件或等待 10 分钟后重试。', 429);
    }
    // Long one-file queues must not fill the cache with already consumed import
    // results. Evict only settled import records; never discard active work or
    // a prepared download that still owns staged bytes.
    if (this.jobs.size >= MAX_JOBS) {
      for (const [id, previous] of this.jobs) {
        if (previous.kind !== 'IMPORT' || previous.status === 'RUNNING') continue;
        this.jobs.delete(id);
        if (previous.timer) clearTimeout(previous.timer);
        if (this.jobs.size < MAX_JOBS) break;
      }
    }
    if (this.jobs.size >= MAX_JOBS) throw new RemoteFileError('云端任务暂存已满，请稍后重试。', 429);
    const job: RemoteTransferJob = { id: randomUUID(), userId: user.id, configId, kind, status: 'RUNNING', controller: new AbortController() };
    this.jobs.set(job.id, job);
    return job;
  }

  private ownedJob(configId: string, jobId: string, user: RequestUser): RemoteTransferJob {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== user.id || job.configId !== configId) throw new NotFoundException('云端取回任务不存在或已过期，请重新选择文件。');
    return job;
  }

  private jobStatus(job: RemoteTransferJob): RemoteTransferStatus {
    return { id: job.id, kind: job.kind, status: job.status,
      ...(job.result ? { result: job.result } : {}), ...(job.name ? { name: job.name, size: job.size } : {}),
      ...(job.error ? { error: job.error } : {}) };
  }

  private finishJob(job: RemoteTransferJob, failed = false): void {
    job.status = failed ? 'FAILED' : 'SUCCEEDED';
    job.expiresAt = Date.now() + JOB_RESULT_TTL_MS;
    job.timer = setTimeout(() => { void this.expireJob(job).catch(() => undefined); }, JOB_RESULT_TTL_MS);
    job.timer.unref?.();
  }

  private failJob(job: RemoteTransferJob, error: unknown): void {
    if (this.stopping || !this.jobs.has(job.id)) return;
    job.error = this.safeFailure(error);
    this.finishJob(job, true);
  }

  private async expireJob(job: RemoteTransferJob): Promise<void> {
    if (this.jobs.get(job.id) !== job) return;
    this.jobs.delete(job.id);
    if (job.timer) clearTimeout(job.timer);
    await job.download?.cleanup();
  }

  private async sweepJobs(): Promise<void> {
    await Promise.all([...this.jobs.values()].filter(job => job.expiresAt !== undefined && job.expiresAt <= Date.now()).map(job => this.expireJob(job)));
  }

  async list(configId: string, query: ListRemoteFilesDto, user: RequestUser): Promise<StorageRemotePage> {
    this.assertAdmin(user);
    this.assertId(configId);
    if (query.parentId !== undefined) this.assertId(query.parentId);
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 2048 || /\p{Cc}/u.test(query.cursor))) {
      throw new RemoteFileError('云端分页参数不正确。');
    }
    const context = await this.context(configId);
    let page: StorageRemotePage;
    try {
      page = await context.adapter.listRemoteFiles!(context.config, { parentId: query.parentId, cursor: query.cursor });
    } catch (error) {
      throw new RemoteFileError('读取云端目录失败，请检查存储连接后重试。', 502, error);
    }
    if (!page || typeof page.parentId !== 'string' || !ID_PATTERN.test(page.parentId) || !Array.isArray(page.items) || page.items.length > 200 ||
      typeof page.nextCursor !== 'string' || page.nextCursor.length > 2048 || /\p{Cc}/u.test(page.nextCursor) ||
      (query.parentId && query.parentId !== 'root' && query.parentId !== page.parentId)) {
      throw new RemoteFileError('云端目录返回的分页信息不正确。', 502);
    }
    const items = page.items.map(item => this.publicItem(item, page.parentId));
    await this.enrichNames(items, configId);
    for (const file of items) {
      const key = this.snapshotKey(user, configId, file.id);
      this.snapshots.delete(key);
      this.snapshots.set(key, { file, expiresAt: Date.now() + SNAPSHOT_TTL_MS });
    }
    while (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
    return { parentId: page.parentId, nextCursor: page.nextCursor, items };
  }

  async download(configId: string, fileId: string, user: RequestUser, signal?: AbortSignal, releaseWhenReady = false): Promise<RemoteFileDownload> {
    this.assertAdmin(user);
    this.assertId(configId);
    this.assertId(fileId);
    const release = this.acquire(user);
    let staged: StagedRemoteFile | undefined;
    try {
      staged = await this.stage(await this.context(configId), fileId, this.maxBytes(), this.snapshot(user, configId, fileId), signal);
      const local = staged;
      if (releaseWhenReady) release();
      const stream = createReadStream(local.path);
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = (): Promise<void> => {
        cleanupPromise ??= (async () => {
          try {
            if (!stream.closed) {
              const closed = new Promise<void>(done => stream.once('close', done));
              stream.destroy();
              await closed;
            }
            await this.safeCleanup(local.root);
          } finally { release(); }
        })();
        return cleanupPromise;
      };
      stream.once('close', () => { void cleanup().catch(() => undefined); });
      return { name: local.name, mimeType: local.mimeType, size: local.size, stream, cleanup };
    } catch (error) {
      try { if (staged) await this.safeCleanup(staged.root); }
      finally { release(); }
      throw error;
    }
  }

  async import(configId: string, dto: ImportRemoteFilesDto, user: RequestUser, signal?: AbortSignal): Promise<RemoteFileImportResult> {
    this.assertAdmin(user);
    this.assertId(configId);
    this.validateImport(dto);
    const release = this.acquire(user);
    try {
      const context = await this.context(configId);
      const projectIds = dto.asBackup ? [] : dto.projectIds ?? [dto.projectId!];
      let maxBytes = Math.min(this.maxBytes(), MAX_BACKUP_BYTES);
      if (!dto.asBackup) {
        for (const projectId of projectIds) await this.projectAccessService.assertProjectAccess(user, projectId, true);
        const limits = await this.settingsService.getUploadLimits();
        maxBytes = Math.min(this.maxBytes(), limits.maxFileSizeBytes);
      }
      // A verified source may take longer to read than the browsing TTL. Pin all
      // proofs before reading the first item, while keeping stale proofs as
      // individual failures and checking source size/hashes again in stage().
      const proofs = new Map<string, { file: StorageRemoteFile | undefined } | { error: unknown }>(dto.fileIds.map(id => {
        try { return [id, { file: this.snapshot(user, configId, id) }] as const; }
        catch (error) { return [id, { error }] as const; }
      }));
      const result: RemoteFileImportResult = { imported: 0, failed: 0, items: [] };
      for (const id of dto.fileIds) {
        signal?.throwIfAborted();
        let name = id;
        let staged: StagedRemoteFile | undefined;
        try {
          const proof = proofs.get(id)!;
          if ('error' in proof) throw proof.error;
          const known = proof.file;
          name = known?.originalName ?? known?.name ?? id;
          staged = await this.stage(context, id, maxBytes, known, signal);
          name = staged.name;
          if (dto.asBackup) {
            const backup = await this.backupService.import(await readFile(staged.path), name, user);
            result.imported++;
            result.items.push({ id, name, status: 'IMPORTED', fileId: backup.id });
          } else {
            for (const projectId of projectIds) {
              // The upload service consumes its multipart path, so each target
              // gets a separate local copy of the single verified cloud read.
              const uploadPath = join(staged.root, `target-${projectId}`);
              try {
                await copyFile(staged.path, uploadPath);
                const file: Express.Multer.File = {
                  fieldname: 'files', encoding: '7bit', mimetype: staged.mimeType,
                  originalname: Buffer.from(name, 'utf8').toString('latin1'),
                  size: staged.size, destination: staged.root, filename: basename(uploadPath), path: uploadPath,
                  stream: Readable.from([]), buffer: undefined as unknown as Buffer,
                };
                const uploaded = await this.filesService.upload(projectId, [file], user, { duplicateStrategy: 'reuse', folderPath: dto.folderPath });
                if (typeof uploaded[0]?.id !== 'string') throw new RemoteFileError('文件登记失败，请稍后重试。', 502);
                result.imported++;
                result.items.push({ id, name, status: 'IMPORTED', fileId: uploaded[0].id, projectId });
              } catch (error) {
                result.failed++;
                result.items.push({ id, name, status: 'FAILED', projectId, error: this.safeFailure(error) });
              } finally { await unlink(uploadPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
            }
          }
        } catch (error) {
          const targets = dto.asBackup ? [undefined] : projectIds;
          for (const projectId of targets) {
            result.failed++;
            result.items.push({ id, name, status: 'FAILED', ...(projectId ? { projectId } : {}), error: this.safeFailure(error) });
          }
        } finally {
          if (staged) await this.safeCleanup(staged.root);
        }
      }
      return result;
    } finally { release(); }
  }

  private async stage(context: RemoteContext, id: string, maxBytes: number, snapshot?: StorageRemoteFile, signal?: AbortSignal): Promise<StagedRemoteFile> {
    signal?.throwIfAborted();
    if (snapshot?.type === 'folder') throw new RemoteFileError('请选择文件，文件夹需要先进入后选择。');
    if (snapshot && snapshot.size > maxBytes) throw new RemoteFileError(`云端文件超过 ${maxBytes} 字节大小上限。`, 413);
    const timeoutMs = this.timeoutMs();
    let remote: Awaited<ReturnType<NonNullable<StorageAdapter['readRemoteFile']>>>;
    try {
      remote = await context.adapter.readRemoteFile!(context.config, id, { maxBytes, timeoutMs });
    } catch (error) {
      throw new RemoteFileError('读取云端文件失败，请检查文件是否存在和存储连接。', 502, error);
    }
    let root: string | undefined;
    try {
      if (!(remote?.stream instanceof Readable) || !this.validName(remote.name) || !Number.isSafeInteger(remote.size) || remote.size < 0 ||
        typeof remote.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(remote.sha1)) {
        throw new RemoteFileError('云端文件返回的名称、大小或校验信息不正确。', 502);
      }
      if (remote.size > maxBytes) throw new RemoteFileError(`云端文件超过 ${maxBytes} 字节大小上限。`, 413);
      if (snapshot && (snapshot.size !== remote.size || (snapshot.sha1 && remote.sha1 && snapshot.sha1.toLowerCase() !== remote.sha1.toLowerCase()))) {
        throw new RemoteFileError('云端文件已变化，请刷新列表后重试。', 409);
      }
      const tempRoot = this.tempRoot();
      await mkdir(tempRoot, { recursive: true });
      root = await mkdtemp(join(tempRoot, 'transfer-'));
      const path = join(root, 'content');
      const digest = createHash('sha1');
      const sha256 = createHash('sha256');
      let size = 0;
      const expectedSize = remote.size;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
          size += chunk.byteLength;
          if (size > maxBytes || size > expectedSize) {
            callback(new RemoteFileError('云端文件传输大小与元数据不一致，请刷新后重试。', 409));
            return;
          }
          digest.update(chunk);
          sha256.update(chunk);
          callback(null, chunk);
        },
      });
      const timeout = AbortSignal.timeout(timeoutMs);
      await pipeline(remote.stream, limit, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      const actualSha1 = digest.digest('hex');
      const expectedSha1 = remote.sha1;
      if (size !== expectedSize || (expectedSha1 && expectedSha1.toLowerCase() !== actualSha1) ||
        (snapshot?.checksum && snapshot.checksum.toLowerCase() !== sha256.digest('hex'))) {
        throw new RemoteFileError('云端文件大小或内容校验失败，请刷新列表后重试。', 409);
      }
      return { root, path, name: snapshot?.originalName ?? remote.name, size, mimeType: this.mimeType(remote.mimeType) };
    } catch (error) {
      if (remote?.stream instanceof Readable) remote.stream.destroy();
      if (root) await this.safeCleanup(root);
      if (error instanceof RemoteFileError) throw error;
      throw new RemoteFileError('云端文件传输中断或校验失败，请重试。', 502, error);
    }
  }

  private async context(configId: string): Promise<RemoteContext> {
    const row = await this.prisma.cdnConfig.findFirst({ where: { id: configId, enabled: true } });
    if (!row) throw new NotFoundException('存储配置不存在或已停用。');
    try {
      const manifest = this.registry.manifest(row.provider);
      const adapter = this.registry.adapter(row.provider);
      if (!manifest?.capabilities.remoteFiles || typeof adapter.listRemoteFiles !== 'function' || typeof adapter.readRemoteFile !== 'function') {
        throw new RemoteFileError('该存储插件尚不支持云端文件浏览和取回。');
      }
      return { config: this.storageService.runtimeConfig(row), adapter };
    } catch (error) {
      if (error instanceof RemoteFileError) throw error;
      throw new RemoteFileError('存储插件不可用，请检查插件安装及存储配置。', 503, error);
    }
  }

  private publicItem(item: StorageRemoteFile, parentId: string): StorageRemoteFile {
    if (!item || typeof item.id !== 'string' || !ID_PATTERN.test(item.id) || item.parentId !== parentId || !this.validName(item.name) ||
      (item.type !== 'file' && item.type !== 'folder') || !Number.isSafeInteger(item.size) || item.size < 0 ||
      (item.sha1 !== undefined && (typeof item.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(item.sha1))) ||
      (item.checksum !== undefined && (typeof item.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(item.checksum))) ||
      (item.project !== undefined && (!item.project || typeof item.project.id !== 'string' || !ID_PATTERN.test(item.project.id) ||
        typeof item.project.name !== 'string' || !item.project.name.trim() || item.project.name.length > 255 || /\p{Cc}/u.test(item.project.name))) ||
      (item.folderPath !== undefined && (typeof item.folderPath !== 'string' || item.folderPath.length > 1024 ||
        /[\\\p{Cc}]/u.test(item.folderPath) || item.folderPath.startsWith('/') ||
        (item.folderPath !== '' && (item.folderPath.split('/').length > 64 || item.folderPath.split('/').some(part => !part || part === '.' || part === '..' || part.length > 255)))))) {
      throw new RemoteFileError('云端目录返回的文件信息不正确。', 502);
    }
    return {
      id: item.id, parentId, name: item.name, type: item.type, size: item.size,
      ...(item.mimeType ? { mimeType: this.mimeType(item.mimeType) } : {}),
      ...(item.sha1 ? { sha1: item.sha1.toLowerCase() } : {}),
      ...(item.checksum ? { checksum: item.checksum.toLowerCase() } : {}),
      ...(typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt)) ? { updatedAt: item.updatedAt } : {}),
      ...(item.originalName && this.validName(item.originalName) ? { originalName: item.originalName } : {}),
      ...(item.storageKey && typeof item.storageKey === 'string' && item.storageKey.length <= 1024 && !/\p{Cc}|:\/\//u.test(item.storageKey) ? { storageKey: item.storageKey } : {}),
      ...(item.project ? { project: { id: item.project.id, name: item.project.name } } : {}),
      ...(item.folderPath !== undefined ? { folderPath: item.folderPath } : {}),
    };
  }

  private async enrichNames(items: StorageRemoteFile[], configId: string): Promise<void> {
    const unidentified = items.filter(item => item.type === 'file' && !item.originalName && /^[a-f0-9]{64}$/i.test(item.name));
    if (unidentified.length === 0) return;
    const hashes = [...new Set(unidentified.map(item => item.name.toLowerCase()))];
    type LocalIdentity = { storageKey: string; originalName: string; size: bigint; checksum: string | null };
    let rows: LocalIdentity[];
    try {
      // Match only the requested page. The key hash identifies an object; the
      // content hash is checked again before a recovered name is used on disk.
      rows = await this.prisma.$queryRaw<LocalIdentity[]>(Prisma.sql`
        SELECT f.storageKey, f.originalName, f.size, f.checksum
          FROM ManagedFile f
         WHERE f.status <> 'DELETED'
           AND SHA2(f.storageKey, 256) IN (${Prisma.join(hashes)})
           AND (f.cdnConfigId = ${configId} OR EXISTS (
             SELECT 1 FROM StorageReplica r
              WHERE r.projectId = f.projectId AND r.storageKey = f.storageKey
                AND r.configId = ${configId} AND r.status = 'READY'
           ))
        UNION ALL
        SELECT v.storageKey, v.originalName, v.size, v.checksum
          FROM FileVersion v
         WHERE v.cdnConfigId = ${configId}
           AND SHA2(v.storageKey, 256) IN (${Prisma.join(hashes)})
        UNION ALL
        SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(b.destination, '$.storageKey')) AS CHAR(512) CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS storageKey,
               b.fileName AS originalName, b.fileSize AS size, b.checksum
          FROM Backup b
         WHERE b.status = 'SUCCEEDED'
           AND JSON_UNQUOTE(JSON_EXTRACT(b.destination, '$.configId')) = ${configId}
           AND JSON_UNQUOTE(JSON_EXTRACT(b.destination, '$.status')) = 'VERIFIED'
           AND SHA2(JSON_UNQUOTE(JSON_EXTRACT(b.destination, '$.storageKey')), 256) IN (${Prisma.join(hashes)})
        LIMIT 2000
      `);
    } catch (error) {
      throw new RemoteFileError('读取本地文件索引失败，请检查数据库结构及连接。', 503, error);
    }
    const candidates = new Map<string, Map<string, LocalIdentity>>();
    for (const row of rows) {
      if (typeof row.storageKey !== 'string' || /\p{Cc}|:\/\//u.test(row.storageKey) || !this.validName(row.originalName) || typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(row.checksum)) continue;
      const hash = createHash('sha256').update(row.storageKey).digest('hex');
      const key = `${hash}\0${Number(row.size)}`;
      const options = candidates.get(key) ?? new Map<string, LocalIdentity>();
      options.set(`${row.originalName}\0${row.checksum.toLowerCase()}`, row);
      candidates.set(key, options);
    }
    for (const item of unidentified) {
      const options = candidates.get(`${item.name.toLowerCase()}\0${item.size}`);
      if (options?.size !== 1) continue;
      const row = options.values().next().value!;
      item.originalName = row.originalName;
      item.storageKey = row.storageKey;
      item.checksum = row.checksum!.toLowerCase();
    }
  }

  private tempRoot(): string {
    return resolve(this.configService.get<string>('REMOTE_FILE_TEMP_ROOT') || join(tmpdir(), 'unified-file-manager-remote'));
  }

  private async safeCleanup(target: string): Promise<void> {
    const absolute = resolve(target);
    if (dirname(absolute) !== this.tempRoot() || !/^transfer-[a-z0-9_-]+$/i.test(basename(absolute))) {
      throw new RemoteFileError('临时文件路径校验失败，已停止清理。', 500);
    }
    await rm(absolute, { recursive: true, force: true });
  }

  private validateImport(dto: ImportRemoteFilesDto): void {
    if (!dto || !Array.isArray(dto.fileIds) || dto.fileIds.length < 1 || dto.fileIds.length > 20 || new Set(dto.fileIds).size !== dto.fileIds.length) {
      throw new RemoteFileError('每次请选择 1 至 20 个不同的云端文件。');
    }
    for (const id of dto.fileIds) this.assertId(id);
    if (dto.asBackup !== undefined && typeof dto.asBackup !== 'boolean') throw new RemoteFileError('备份导入选项不正确。');
    if (dto.projectIds !== undefined) {
      if (dto.asBackup || dto.projectId !== undefined || !Array.isArray(dto.projectIds) || dto.projectIds.length < 1 || dto.projectIds.length > 20 || new Set(dto.projectIds).size !== dto.projectIds.length) {
        throw new RemoteFileError('请选择 1 至 20 个不同的目标项目，单项目与多项目参数不能同时提供。');
      }
      for (const projectId of dto.projectIds) this.assertId(projectId);
    } else if (!dto.asBackup || dto.projectId !== undefined) this.assertId(dto.projectId);
    if (dto.folderPath !== undefined && (typeof dto.folderPath !== 'string' || dto.folderPath.length > 512 || /\p{Cc}/u.test(dto.folderPath) || dto.folderPath.split(/[\\/]/).some(part => part === '.' || part === '..'))) {
      throw new RemoteFileError('目标文件夹路径不正确。');
    }
  }

  private assertAdmin(user: RequestUser): void {
    if (user.role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('只有超级管理员可以管理云端文件。');
  }

  private assertId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new RemoteFileError('云端文件、存储或项目标识不正确。');
  }

  private validName(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 255 && !/[\\/\p{Cc}]/u.test(value) && value !== '.' && value !== '..';
  }

  private mimeType(value: string | undefined): string {
    return typeof value === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value) ? value : 'application/octet-stream';
  }

  private maxBytes(): number {
    const value = Number(this.configService.get<number>('REMOTE_FILE_MAX_BYTES', DEFAULT_MAX_BYTES));
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
  }

  private timeoutMs(): number {
    const configured = this.configService.get<unknown>('REMOTE_FILE_TIMEOUT_MS');
    const value = typeof configured === 'number' || typeof configured === 'string' ? Number(configured) : Number.NaN;
    return Number.isSafeInteger(value) && value > 0 ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, value)) : MAX_TIMEOUT_MS;
  }

  private acquire(user: RequestUser): () => void {
    if (this.activeUsers.has(user.id)) throw new ConflictException('已有云端文件任务正在处理中，请等待完成后重试。');
    this.activeUsers.add(user.id);
    let held = true;
    return () => { if (held) { held = false; this.activeUsers.delete(user.id); } };
  }

  private snapshotKey(user: RequestUser, configId: string, fileId: string): string { return `${user.id}\0${configId}\0${fileId}`; }

  private snapshot(user: RequestUser, configId: string, id: string): StorageRemoteFile | undefined {
    const key = this.snapshotKey(user, configId, id);
    const value = this.snapshots.get(key);
    if (!value) return undefined;
    if (value.expiresAt <= Date.now()) throw new RemoteFileError('云端列表已过期，请刷新后重试。', 409);
    return value.file;
  }

  private safeFailure(error: unknown): string {
    if (error instanceof RemoteFileError) return error.message;
    if (error instanceof HttpException) {
      if (error.getStatus() === 413) return '文件超过允许的上传大小。';
      if (error.getStatus() === 403) return '无权写入目标项目。';
      if (error.getStatus() === 404) return '云端文件或目标项目不存在。';
      if (error.getStatus() === 400) return '导入失败，请检查文件格式、项目配额与存储配置。';
    }
    return '拉取失败，请稍后重试或检查存储连接。';
  }
}
