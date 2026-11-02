package com.ufm.share;

import java.time.OffsetDateTime;
import java.util.UUID;

public record ShareRow(UUID id,UUID fileId,UUID folderId,String token,String customPath,String passwordHash,
                       OffsetDateTime expiresAt,Long maxDownloads,long downloadCount,boolean previewOnly,
                       String allowedIps,String watermark,boolean enabled,OffsetDateTime deletedAt) {}
