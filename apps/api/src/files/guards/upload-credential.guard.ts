import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { UploadCredentialService, type ValidatedUploadCredential } from '../upload-credential.service';

export type UploadCredentialRequest = Request & {
  uploadCredential?: ValidatedUploadCredential;
  params: { projectId?: string };
};

/**
 * Optional guard for upload endpoints that accept `Authorization: Upload <token>`.
 * Does not replace JwtAuthGuard — use when the route is intentionally credential-only
 * or when a dual-auth controller manually falls back to JWT.
 */
@Injectable()
export class UploadCredentialGuard implements CanActivate {
  constructor(private readonly uploadCredentialService: UploadCredentialService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UploadCredentialRequest>();
    const projectId = request.params?.projectId;
    if (!projectId) {
      throw new UnauthorizedException('缺少项目 ID。');
    }

    const header = request.headers.authorization;
    const credential = await this.uploadCredentialService.validateToken(projectId, header);
    request.uploadCredential = credential;
    return true;
  }
}
