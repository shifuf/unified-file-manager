import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { BackupService, type BackupView, type RestoreResult } from './backup.service';
import { CreateBackupDto } from './dto/create-backup.dto';
import { RestoreBackupDto } from './dto/restore-backup.dto';

@ApiTags('备份')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('backups')
export class BackupController {
  constructor(private readonly backupService: BackupService) {}

  @Get()
  list(@CurrentUser() user: RequestUser): Promise<BackupView[]> {
    return this.backupService.list(user);
  }

  /** Scope catalogue so the console can render the selective backup/restore UI. */
  @Get('scopes')
  scopes(): Array<{ key: string; label: string; description: string; models: string[] }> {
    return this.backupService.scopeCatalog();
  }

  /** Register a previously downloaded backup archive so it can be restored. */
  @Post('import')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 256 * 1024 * 1024 },
    }),
  )
  import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: RequestUser,
  ): Promise<BackupView> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('请选择要导入的备份文件。');
    }
    return this.backupService.import(file.buffer, file.originalname, user);
  }

  @Post()
  create(@Body() dto: CreateBackupDto, @CurrentUser() user: RequestUser): Promise<BackupView> {
    return this.backupService.create(dto, user);
  }

  @Get(':backupId')
  get(@Param('backupId') backupId: string, @CurrentUser() user: RequestUser): Promise<BackupView> {
    return this.backupService.get(backupId, user);
  }

  @Get(':backupId/download')
  @Header('Content-Type', 'application/gzip')
  async download(
    @Param('backupId') backupId: string,
    @CurrentUser() user: RequestUser,
    @Res() response: Response,
  ): Promise<void> {
    const archive = await this.backupService.archive(backupId, user);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`,
    );
    response.setHeader('Content-Length', String(archive.size));
    archive.stream.once('error', () => response.destroy());
    archive.stream.pipe(response);
  }

  @Post(':backupId/restore')
  restore(
    @Param('backupId') backupId: string,
    @Body() dto: RestoreBackupDto,
    @CurrentUser() user: RequestUser,
  ): Promise<RestoreResult> {
    return this.backupService.restore(backupId, dto, user);
  }

  @Delete(':backupId')
  remove(
    @Param('backupId') backupId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ success: boolean }> {
    return this.backupService.remove(backupId, user);
  }
}
