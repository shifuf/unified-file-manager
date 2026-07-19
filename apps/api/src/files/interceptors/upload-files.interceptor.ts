import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import multer, { diskStorage } from 'multer';
import type { Observable } from 'rxjs';

import { SettingsService, type UploadLimits } from '../../settings/settings.service';

@Injectable()
export class UploadFilesInterceptor implements NestInterceptor {
  constructor(private readonly settingsService: SettingsService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const limits = await this.settingsService.getUploadLimits();
    const uploadTempDir = this.uploadTempDir();
    await mkdir(uploadTempDir, { recursive: true });
    const upload = multer({
      storage: diskStorage({
        destination: uploadTempDir,
        filename: (_request, _file, callback) => {
          callback(null, `${Date.now()}-${randomUUID()}`);
        },
      }),
      limits: {
        fileSize: limits.maxFileSizeBytes,
        files: limits.maxBatchUploadCount,
      },
    }).array('files');

    await new Promise<void>((resolve, reject) => {
      upload(request, response, (error: unknown) => {
        if (error) {
          reject(this.toHttpError(error, limits));
          return;
        }

        resolve();
      });
    });

    return next.handle();
  }

  private toHttpError(error: unknown, limits: UploadLimits): Error {
    const code = this.readErrorCode(error);

    if (code === 'LIMIT_FILE_SIZE') {
      return new PayloadTooLargeException(`单个文件不能超过 ${limits.maxFileSizeMb} MB。`);
    }

    if (code === 'LIMIT_FILE_COUNT') {
      return new BadRequestException(`单次最多上传 ${limits.maxBatchUploadCount} 个文件。`);
    }

    if (code === 'LIMIT_UNEXPECTED_FILE') {
      return new BadRequestException('上传字段名称错误，请使用 files。');
    }

    if (error instanceof Error && error.message) {
      return new BadRequestException(error.message);
    }

    return new BadRequestException('文件上传失败。');
  }

  private readErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String((error as { code?: unknown }).code ?? '');
    }

    return '';
  }

  private uploadTempDir(): string {
    return join(tmpdir(), 'unified-file-manager-uploads');
  }
}
