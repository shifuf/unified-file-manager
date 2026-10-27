import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { ReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, Prisma, UserRole, type Backup } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../common/types/request-user.type';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_SCOPES,
  BACKUP_SCOPE_KEYS,
  isBackupScopeKey,
  modelsForScopes,
  REPLACE_DELETE_ORDER,
  type BackupModelName,
  type BackupScopeKey,
} from './backup.constants';
import type { CreateBackupDto } from './dto/create-backup.dto';
import type { RestoreBackupDto } from './dto/restore-backup.dto';
import { decompressBackupBuffer, validateBackupPayload, verifyBackupChecksum } from './backup-archive.util';

type BackupRow = Record<string, unknown>;

type BackupObjectEntry = {
  cdnConfigId: string;
  storageKey: string;
  mimeType: string;
  originalName: string;
  size: number;
  data: string;
};

type BackupPayload = {
  formatVersion: number;
  createdAt: string;
  scopes: BackupScopeKey[];
  tables: Record<string, BackupRow[]>;
  objects: BackupObjectEntry[];
  warnings: string[];
};

type DmmfField = { name: string; kind: string; type: string };
type DmmfModel = { name: string; fields: DmmfField[] };

type RowDelegate = {
  findMany: (args?: Record<string, unknown>) => Promise<BackupRow[]>;
  createMany: (args: { data: BackupRow[]; skipDuplicates?: boolean }) => Promise<{ count: number }>;
  deleteMany: () => Promise<{ count: number }>;
};

export type BackupView = {
  id: string;
  name: string;
  status: Backup['status'];
  includeObjects: boolean;
  fileName: string | null;
  fileSize: number;
  checksum: string | null;
  tableCounts: Record<string, number>;
  tableRows: Record<string, number>;
  scopes: BackupScopeKey[];
  objectCount: number;
  objectBytes: number;
  message: string | null;
  createdById: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  fileAvailable: boolean;
};

export type RestoreResult = {
  backupId: string;
  mode: 'merge' | 'replace';
  scopes: BackupScopeKey[];
  restored: Record<string, number>;
  objectsRestored: number;
  failures: string[];
};

export type BackupArchive = {
  path: string;
  fileName: string;
  size: number;
  stream: ReadStream;
};

const DEFAULT_MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Full logical backups: every Prisma model is exported into a gzipped JSON
 * archive, optionally together with the bytes of LOCAL storage objects so a
 * bare-metal restore can rebuild the database *and* the local file tree.
 *
 * Cloud objects are intentionally not copied — they already live on the remote
 * provider and are referenced by `cdnConfigId` + `storageKey`.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  async list(user: RequestUser): Promise<BackupView[]> {
    this.assertCanManageBackups(user);
    const rows = await this.prisma.backup.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.toView(row));
  }

  async get(id: string, user: RequestUser): Promise<BackupView> {
    this.assertCanManageBackups(user);
    return this.toView(await this.findBackup(id));
  }

  async create(dto: CreateBackupDto, user: RequestUser): Promise<BackupView> {
    this.assertCanManageBackups(user);
    const name = (dto.name ?? '').trim() || `全量备份 ${new Date().toLocaleString('zh-CN')}`;
    const scopes = this.resolveScopes(dto.scopes);
    const includeObjects = Boolean(dto.includeObjects);

    const record = await this.prisma.backup.create({
      data: {
        name,
        includeObjects,
        scopes: scopes as unknown as Prisma.InputJsonValue,
        status: 'RUNNING',
        startedAt: new Date(),
        createdById: user.id,
      },
    });

    try {
      const result = await this.buildArchive(record.id, includeObjects, scopes);
      const updated = await this.prisma.backup.update({
        where: { id: record.id },
        data: {
          status: 'SUCCEEDED',
          fileName: result.fileName,
          fileSize: BigInt(result.fileSize),
          checksum: result.checksum,
          tableCounts: result.tableCounts,
          tableRows: result.tableRows,
          objectCount: result.objectCount,
          objectBytes: BigInt(result.objectBytes),
          message: result.warnings.length > 0 ? result.warnings.join('\n') : null,
          finishedAt: new Date(),
        },
      });

      await this.auditService.write({
        action: AuditAction.BACKUP_CREATE,
        actorId: user.id,
        detail: {
          backupId: record.id,
          includeObjects,
          fileSize: result.fileSize,
          objectCount: result.objectCount,
        },
      });

      return this.toView(updated);
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`备份失败 id=${record.id}：${message}`);
      await this.prisma.backup.update({
        where: { id: record.id },
        data: { status: 'FAILED', message, finishedAt: new Date() },
      });
      throw new BadRequestException(`备份失败：${message}`);
    }
  }

  /**
   * Register a previously downloaded backup file so it can be restored after a
   * wipe (download -> keep offline -> import -> restore).
   */
  async import(buffer: Buffer, fileName: string | undefined, user: RequestUser): Promise<BackupView> {
    this.assertCanManageBackups(user);
    if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0 || buffer.byteLength > MAX_BACKUP_ARCHIVE_BYTES) {
      throw new BadRequestException(`备份文件必须大于 0 且不超过 ${MAX_BACKUP_ARCHIVE_BYTES} 字节。`);
    }

    let payload: BackupPayload;
    try {
      payload = this.readPayload(decompressBackupBuffer(buffer).toString('utf8'));
    } catch (error) {
      throw new BadRequestException(`无法解析备份文件：${this.errorMessage(error)}`);
    }

    const originalName = this.sanitizeFileName(fileName);
    const safeName = `ufm-backup-import-${randomUUID()}.json.gz`;
    const root = this.backupRoot();
    await mkdir(root, { recursive: true });
    const archivePath = resolve(root, safeName);
    await writeFile(archivePath, buffer, { flag: 'wx' });

    const rowCounts = Object.fromEntries(
      Object.entries(payload.tables).map(([model, rows]) => [model, rows.length]),
    );
    let record: Backup;
    try {
      record = await this.prisma.backup.create({
      data: {
        name: `导入的备份 ${payload.createdAt}${originalName ? ` (${originalName})` : ''}`,
        status: 'SUCCEEDED',
        includeObjects: payload.objects.length > 0,
        fileName: safeName,
        fileSize: BigInt(buffer.byteLength),
        checksum: createHash('sha256').update(buffer).digest('hex'),
        tableCounts: rowCounts,
        tableRows: rowCounts,
        scopes: payload.scopes as unknown as Prisma.InputJsonValue,
        objectCount: payload.objects.length,
        objectBytes: BigInt(payload.objects.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0)),
        message: payload.warnings.length > 0 ? payload.warnings.join('\n') : null,
        createdById: user.id,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
      });
    } catch (error) {
      await rm(archivePath, { force: true }).catch(() => undefined);
      throw error;
    }

    await this.auditService.write({
      action: AuditAction.BACKUP_CREATE,
      actorId: user.id,
      detail: { backupId: record.id, imported: true, fileName: safeName, scopes: payload.scopes },
    });

    return this.toView(record);
  }

  private sanitizeFileName(value: string | undefined): string {
    const base = basename(String(value ?? '').trim());
    return base.replace(/[^\w.-]+/g, '_').slice(0, 200);
  }

  async archive(id: string, user: RequestUser): Promise<BackupArchive> {
    this.assertCanManageBackups(user);
    const record = await this.findBackup(id);

    if (record.status !== 'SUCCEEDED' || !record.fileName) {
      throw new BadRequestException('该备份没有可下载的文件。');
    }

    const path = this.archivePath(record.fileName);
    if (!existsSync(path)) {
      throw new NotFoundException('备份文件已丢失，请重新创建。');
    }

    await this.auditService.write({
      action: AuditAction.BACKUP_DOWNLOAD,
      actorId: user.id,
      detail: { backupId: record.id, fileName: record.fileName },
    });

    return {
      path,
      fileName: record.fileName,
      size: Number(record.fileSize),
      stream: createReadStream(path),
    };
  }

  async restore(id: string, dto: RestoreBackupDto, user: RequestUser): Promise<RestoreResult> {
    this.assertCanManageBackups(user);
    const record = await this.findBackup(id);

    if (record.status !== 'SUCCEEDED' || !record.fileName) {
      throw new BadRequestException('该备份不可用于恢复。');
    }

    const path = this.archivePath(record.fileName);
    if (!existsSync(path)) {
      throw new NotFoundException('备份文件已丢失，无法恢复。');
    }

    const archiveBuffer = await readFile(path);
    if (!verifyBackupChecksum(archiveBuffer, record.checksum)) {
      throw new BadRequestException('备份文件校验失败，文件可能已损坏或被篡改。');
    }
    const payload = this.readPayload(decompressBackupBuffer(archiveBuffer).toString('utf8'));
    const mode = dto.mode ?? 'merge';
    // Default to "restore exactly what this backup contains"; the caller may pick
    // a narrower subset, but never a scope the archive does not carry.
    const requested = dto.scopes === undefined ? payload.scopes : this.resolveScopes(dto.scopes);
    const scopes = requested.filter((scope) => payload.scopes.includes(scope));
    if (scopes.length === 0) {
      throw new BadRequestException('所选内容不在该备份中，无法恢复。');
    }

    const restored: Record<string, number> = {};
    const failures: string[] = [];
    const selectedModels = modelsForScopes(scopes);
    const selected = new Set<string>(selectedModels);

    if (mode === 'replace') {
      // Clear only the selected business data so unselected domains stay intact.
      for (const model of REPLACE_DELETE_ORDER) {
        if (selected.has(model)) {
          await this.delegate(model).deleteMany();
        }
      }
    }

    for (const model of selectedModels) {
      const rows = payload.tables[model] ?? [];
      if (rows.length === 0) {
        continue;
      }

      try {
        const result = await this.delegate(model).createMany({
          data: rows.map((row) => this.fromJsonRow(model, row)),
          skipDuplicates: true,
        });
        restored[model] = result.count;
      } catch (error) {
        failures.push(`${model}: ${this.errorMessage(error)}`);
      }
    }

    let objectsRestored = 0;
    const objects = scopes.includes('projects') ? payload.objects : [];
    for (const entry of objects) {
      try {
        await this.storageService.uploadToConfig(entry.cdnConfigId, {
          key: entry.storageKey,
          buffer: Buffer.from(entry.data, 'base64'),
          mimeType: entry.mimeType,
          originalName: entry.originalName,
        });
        objectsRestored += 1;
      } catch (error) {
        failures.push(`对象 ${entry.storageKey}: ${this.errorMessage(error)}`);
      }
    }

    await this.auditService.write({
      action: AuditAction.BACKUP_RESTORE,
      actorId: user.id,
      detail: { backupId: record.id, mode, scopes, objectsRestored, failures: failures.length },
    });

    return { backupId: record.id, mode, scopes, restored, objectsRestored, failures };
  }

  async remove(id: string, user: RequestUser): Promise<{ success: boolean }> {
    this.assertCanManageBackups(user);
    const record = await this.findBackup(id);

    if (record.fileName) {
      await rm(this.archivePath(record.fileName), { force: true }).catch(() => undefined);
    }

    await this.prisma.backup.delete({ where: { id } });

    await this.auditService.write({
      action: AuditAction.BACKUP_DELETE,
      actorId: user.id,
      detail: { backupId: id, fileName: record.fileName },
    });

    return { success: true };
  }

  private async buildArchive(
    backupId: string,
    includeObjects: boolean,
    scopes: BackupScopeKey[],
  ): Promise<{
    fileName: string;
    fileSize: number;
    checksum: string;
    tableCounts: Record<string, number>;
    tableRows: Record<string, number>;
    objectCount: number;
    objectBytes: number;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const tables: Record<string, BackupRow[]> = {};
    const rowCounts: Record<string, number> = {};
    const selectedModels = modelsForScopes(scopes);

    for (const model of selectedModels) {
      const rows = await this.delegate(model).findMany();
      tables[model] = rows.map((row) => {
        const serialized = this.toJsonRow(model, row);
        this.assertRowSerializable(model, row, serialized);
        return serialized;
      });
      rowCounts[model] = rows.length;
    }

    const objects = includeObjects && scopes.includes('projects')
      ? await this.collectObjects(warnings)
      : [];

    const payload: BackupPayload = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      scopes,
      tables,
      objects,
      warnings,
    };

    const buffer = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
    const fileName = `ufm-backup-${this.stamp()}-${backupId}.json.gz`;
    const root = this.backupRoot();
    await mkdir(root, { recursive: true });
    await writeFile(resolve(root, fileName), buffer);

    return {
      fileName,
      fileSize: buffer.byteLength,
      checksum: createHash('sha256').update(buffer).digest('hex'),
      tableCounts: { ...rowCounts },
      tableRows: { ...rowCounts },
      objectCount: objects.length,
      objectBytes: objects.reduce((sum, entry) => sum + entry.size, 0),
      warnings,
    };
  }

  /** Read LOCAL objects so a restore can rebuild the file tree without the provider. */
  private async collectObjects(warnings: string[]): Promise<BackupObjectEntry[]> {
    const maxBytes = this.configService.get<number>('BACKUP_MAX_OBJECT_BYTES', DEFAULT_MAX_OBJECT_BYTES);
    const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
      ? Number(maxBytes)
      : DEFAULT_MAX_OBJECT_BYTES;

    const files = await this.prisma.managedFile.findMany({
      where: { status: { not: 'DELETED' }, cdnConfig: { provider: 'LOCAL' } },
      include: { cdnConfig: true },
    });

    const entries: BackupObjectEntry[] = [];
    let total = 0;

    for (const file of files) {
      if (total >= limit) {
        warnings.push(`本地对象超过 ${Math.round(limit / 1024 / 1024)}MB 上限，其余文件未打包。`);
        break;
      }

      try {
        const target = await this.storageService.getDownloadTarget(file, 300, undefined, {
          preferRedirect: false,
        });
        if (!target.stream) {
          continue;
        }

        const buffer = await this.readStream(target.stream);
        if (total + buffer.byteLength > limit) {
          warnings.push(`本地对象超过 ${Math.round(limit / 1024 / 1024)}MB 上限，其余文件未打包。`);
          break;
        }

        total += buffer.byteLength;
        entries.push({
          cdnConfigId: file.cdnConfigId ?? '',
          storageKey: file.storageKey,
          mimeType: file.mimeType,
          originalName: file.originalName,
          size: buffer.byteLength,
          data: buffer.toString('base64'),
        });
      } catch (error) {
        warnings.push(`读取 ${file.originalName} 失败：${this.errorMessage(error)}`);
      }
    }

    return entries;
  }

  private readPayload(raw: string): BackupPayload {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      return validateBackupPayload(parsed) as BackupPayload;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(error instanceof Error ? error.message : '备份文件格式不正确。');
    }
  }

  private toJsonRow(model: BackupModelName, row: BackupRow): BackupRow {
    const meta = this.modelMeta(model);
    const out: BackupRow = {};

    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) {
        out[key] = null;
        continue;
      }
      if (typeof value === 'bigint') {
        out[key] = value.toString();
        continue;
      }
      if (value instanceof Date) {
        out[key] = value.toISOString();
        continue;
      }

      const field = meta?.fields.find((item) => item.name === key);
      if (field?.kind === 'object') {
        continue;
      }

      out[key] = value;
    }

    return out;
  }

  private fromJsonRow(model: BackupModelName, row: BackupRow): BackupRow {
    const meta = this.modelMeta(model);
    const out: BackupRow = {};

    for (const [key, value] of Object.entries(row)) {
      const field = meta?.fields.find((item) => item.name === key);
      if (!field) {
        continue;
      }

      if (value === null || value === undefined) {
        out[key] = null;
        continue;
      }
      if (field.type === 'BigInt' && typeof value !== 'bigint') {
        out[key] = BigInt(String(value));
        continue;
      }
      if (field.type === 'DateTime' && typeof value === 'string') {
        out[key] = new Date(value);
        continue;
      }

      out[key] = value;
    }

    return out;
  }

  /**
   * DMMF lists models by their schema name (`User`), while the Prisma client
   * delegate — and therefore `BACKUP_MODELS` — uses camelCase (`user`).
   */
  private modelMeta(model: BackupModelName): DmmfModel | null {
    const datamodel = (Prisma.dmmf as unknown as { datamodel: { models: DmmfModel[] } }).datamodel;
    const target = model.toLowerCase();
    return datamodel.models.find((item) => item.name.toLowerCase() === target) ?? null;
  }

  /** Guard: a serialized row must never silently lose every column. */
  private assertRowSerializable(model: BackupModelName, source: BackupRow, serialized: BackupRow): void {
    if (Object.keys(source).length > 0 && Object.keys(serialized).length === 0) {
      throw new BadRequestException(`备份序列化失败：${model} 的字段元数据缺失。`);
    }
  }

  private delegate(model: BackupModelName): RowDelegate {
    const container = this.prisma as unknown as Record<string, RowDelegate | undefined>;
    const value = container[model];
    if (!value || typeof value.findMany !== 'function') {
      throw new BadRequestException(`不支持的备份数据表：${model}`);
    }
    return value;
  }

  private async findBackup(id: string): Promise<Backup> {
    const record = await this.prisma.backup.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('备份不存在。');
    }
    return record;
  }

  private toView(record: Backup): BackupView {
    return {
      id: record.id,
      name: record.name,
      status: record.status,
      includeObjects: record.includeObjects,
      fileName: record.fileName,
      fileSize: Number(record.fileSize),
      checksum: record.checksum,
      tableCounts: this.asCountRecord(record.tableCounts),
      tableRows: this.asCountRecord(record.tableRows),
      scopes: this.asScopeList(record.scopes),
      objectCount: record.objectCount,
      objectBytes: Number(record.objectBytes),
      message: record.message,
      createdById: record.createdById,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      fileAvailable: Boolean(record.fileName) && existsSync(this.archivePath(record.fileName as string)),
    };
  }

  private asCountRecord(value: Prisma.JsonValue | null): Record<string, number> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      return {};
    }

    const out: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = Number(entry) || 0;
    }
    return out;
  }

  private assertCanManageBackups(user: RequestUser): void {
    if (user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('只有超级管理员可以管理备份。');
    }
  }

  private archivePath(fileName: string): string {
    return resolve(this.backupRoot(), basename(fileName));
  }

  private backupRoot(): string {
    const configured = (this.configService.get<string>('BACKUP_ROOT') ?? '').trim() || './backups';
    return resolve(isAbsolute(configured) ? configured : resolve(this.workspaceRoot(), configured));
  }

  private workspaceRoot(): string {
    const cwd = process.cwd();
    const current = basename(cwd);
    if (current === 'api' && basename(dirname(cwd)) === 'apps') {
      return resolve(cwd, '../..');
    }
    if (current === 'dist' && basename(dirname(cwd)) === 'api') {
      return resolve(cwd, '../../../..');
    }
    return cwd;
  }

  private stamp(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    return (
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    );
  }

  private resolveScopes(input?: readonly string[] | null): BackupScopeKey[] {
    const values = Array.isArray(input) ? input : [];
    const valid = values.filter((value): value is BackupScopeKey => typeof value === 'string' && isBackupScopeKey(value));
    const unique = BACKUP_SCOPE_KEYS.filter((scope) => valid.includes(scope));
    return unique.length > 0 ? unique : [...BACKUP_SCOPE_KEYS];
  }

  private asScopeList(value: Prisma.JsonValue | null): BackupScopeKey[] {
    if (!Array.isArray(value)) {
      return [...BACKUP_SCOPE_KEYS];
    }
    return this.resolveScopes(value.filter((item): item is string => typeof item === 'string'));
  }

  /** Human readable scope catalogue for the console. */
  scopeCatalog(): Array<{ key: BackupScopeKey; label: string; description: string; models: string[] }> {
    return BACKUP_SCOPE_KEYS.map((key) => ({
      key,
      label: BACKUP_SCOPES[key].label,
      description: BACKUP_SCOPES[key].description,
      models: [...BACKUP_SCOPES[key].models],
    }));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
  }

  private async readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
    }
    return Buffer.concat(chunks);
  }
}
