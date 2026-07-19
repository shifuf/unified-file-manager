import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { ensureDatabaseUrl } from './common/utils/database-url.util';
import {
  buildFrameAncestors,
  buildRequestPublicBaseUrl,
  getConfiguredPublicUrl,
  parseOrigins,
} from './common/utils/origin.util';
import { runWithRequestContext } from './common/utils/request-context.util';
import { getConfigBoolean, isProduction } from './common/utils/security-config.util';

async function bootstrap(): Promise<void> {
  // Prisma reads process.env.DATABASE_URL; derive from MYSQL_* when omitted.
  ensureDatabaseUrl();

  const app = await NestFactory.create(AppModule, { cors: false, rawBody: true });
  const configService = app.get(ConfigService);
  // Optional. When unset, share/public URLs use the request Host; CORS reflects the caller.
  const webPublicUrl = getConfiguredPublicUrl((key) => configService.get<string>(key));
  const webOrigins = webPublicUrl ? parseOrigins(webPublicUrl) : [];

  app.getHttpAdapter().getInstance().set('trust proxy', resolveTrustProxy(configService));
  app.setGlobalPrefix('api');

  // Capture scheme+host per request so public/share links can omit PUBLIC_URL (IP:port).
  app.use(
    (
      req: { get: (name: string) => string | undefined; protocol?: string; secure?: boolean },
      _res: unknown,
      next: () => void,
    ) => {
      const publicBaseUrl = buildRequestPublicBaseUrl(req);
      runWithRequestContext({ publicBaseUrl }, () => next());
    },
  );

  app.enableCors({
    origin: webOrigins.length > 0 ? webOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  const requireHttps = getConfigBoolean(configService, 'REQUIRE_HTTPS', false);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      xFrameOptions: false,
      strictTransportSecurity: requireHttps
        ? {
            maxAge: 31_536_000,
            includeSubDomains: true,
          }
        : false,
      contentSecurityPolicy: {
        directives: {
          frameAncestors: buildFrameAncestors(webOrigins).split(' '),
        },
      },
    }),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger follows NODE_ENV: on in development/test, off in production.
  if (!isProduction(configService)) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('统一文件管理系统 API')
      .setDescription('多项目文件管理、存储配置切换、项目密钥签名与文件访问接口')
      .setVersion('1.0.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'x-app-id', in: 'header' }, 'AppID')
      .addApiKey({ type: 'apiKey', name: 'x-signature', in: 'header' }, 'Signature')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = configService.get<number>('APP_PORT', 60557);
  const host = configService.get<string>('APP_HOST', '0.0.0.0');
  await app.listen(port, host);
}

/**
 * Resolve Express's `trust proxy` setting. The standard deployment always sits
 * behind nginx, so the default trusts a single hop. Operators exposing the API
 * directly (no reverse proxy) should set TRUST_PROXY=false so forged
 * X-Forwarded-* headers can't spoof the client IP / scheme / host.
 */
function resolveTrustProxy(configService: ConfigService): boolean | number {
  const raw = configService.get<string>('TRUST_PROXY', '1').trim().toLowerCase();

  if (['false', '0', 'no', 'off'].includes(raw)) {
    return false;
  }

  if (['true', 'yes', 'on'].includes(raw)) {
    return true;
  }

  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 0 ? hops : 1;
}

void bootstrap();
