import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { UploadCredentialGuard, type UploadCredentialRequest } from './guards/upload-credential.guard';
import { UploadCredentialService } from './upload-credential.service';

class CreateUploadCredentialDto {
  @ApiProperty({ example: 'CI 上传令牌' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ description: '有效期秒数，默认 7 天' })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(90 * 24 * 60 * 60)
  expiresInSeconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxBytes?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  maxFiles?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedMimeTypes?: string[];
}

class PresignUploadDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  size!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  mimeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;
}

class CompletePresignDto {
  @ApiProperty()
  @IsString()
  @MaxLength(512)
  storageKey!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  size!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  mimeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  folderPath?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  publicUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  checksum?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  credentialId?: string | null;

  @ApiPropertyOptional({
    enum: ['reject', 'reuse', 'replace'],
    description: '重复文件处理策略。与 multipart/分片上传一致；有 checksum 时按内容去重',
  })
  @IsOptional()
  @IsIn(['reject', 'reuse', 'replace'])
  duplicateStrategy?: 'reject' | 'reuse' | 'replace';
}

@ApiTags('上传凭证')
@Controller()
export class UploadCredentialController {
  constructor(private readonly uploadCredentialService: UploadCredentialService) {}

  @Post('projects/:projectId/upload-credentials')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateUploadCredentialDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<UploadCredentialService['create']> {
    return this.uploadCredentialService.create(projectId, dto, user);
  }

  @Get('projects/:projectId/upload-credentials')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  list(
    @Param('projectId') projectId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<UploadCredentialService['list']> {
    return this.uploadCredentialService.list(projectId, user);
  }

  @Delete('projects/:projectId/upload-credentials/:credentialId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  revoke(
    @Param('projectId') projectId: string,
    @Param('credentialId') credentialId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<UploadCredentialService['revoke']> {
    return this.uploadCredentialService.revoke(projectId, credentialId, user);
  }

  @Post('projects/:projectId/uploads/presign')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  presign(
    @Param('projectId') projectId: string,
    @Body() dto: PresignUploadDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<UploadCredentialService['createPresign']> {
    return this.uploadCredentialService.createPresign(projectId, dto, user);
  }

  @Post('projects/:projectId/uploads/complete-presign')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  completePresign(
    @Param('projectId') projectId: string,
    @Body() dto: CompletePresignDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<UploadCredentialService['completePresign']> {
    return this.uploadCredentialService.completePresign(projectId, dto, user);
  }

  /** Credential-token presign: Authorization: Upload <token> */
  @Post('projects/:projectId/uploads/credential-presign')
  @UseGuards(UploadCredentialGuard)
  credentialPresign(
    @Param('projectId') projectId: string,
    @Body() dto: PresignUploadDto,
    @Req() request: UploadCredentialRequest,
  ): ReturnType<UploadCredentialService['createPresign']> {
    return this.uploadCredentialService.createPresign(projectId, dto, undefined, request.uploadCredential);
  }

  /** Credential-token complete-presign: Authorization: Upload <token> */
  @Post('projects/:projectId/uploads/credential-complete-presign')
  @UseGuards(UploadCredentialGuard)
  credentialCompletePresign(
    @Param('projectId') projectId: string,
    @Body() dto: CompletePresignDto,
    @Req() request: UploadCredentialRequest,
  ): ReturnType<UploadCredentialService['completePresign']> {
    return this.uploadCredentialService.completePresign(
      projectId,
      dto,
      undefined,
      request.uploadCredential,
    );
  }
}
