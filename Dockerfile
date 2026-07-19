ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# workspace package — required by root package.json workspaces / lockfile
COPY packages/sdk-js/package.json packages/sdk-js/package.json
RUN npm config set registry "$NPM_REGISTRY" \
    && npm ci --include=optional --no-audit --fund=false

FROM deps AS source
WORKDIR /app
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/sdk-js packages/sdk-js

FROM source AS api-build
ENV DATABASE_URL=mysql://ufm:ufm_password@mysql:3306/unified_file_manager
RUN npm --workspace apps/api run prisma:generate
RUN npm --workspace apps/api run build

FROM source AS web-build
RUN npm --workspace apps/web run build

FROM ${NODE_IMAGE} AS api
WORKDIR /app
# ffmpeg enables cover extraction / optional VIDEO_TRANSCODE / VIDEO_HLS pipelines.
RUN apk add --no-cache openssl su-exec ffmpeg
ENV NODE_ENV=production
COPY --from=api-build /app/node_modules ./node_modules
COPY --from=api-build /app/apps/api/dist ./apps/api/dist
COPY --from=api-build /app/apps/api/prisma ./apps/api/prisma
COPY --from=api-build /app/apps/api/scripts ./apps/api/scripts
COPY --from=api-build /app/apps/api/package.json ./apps/api/package.json
COPY apps/api/docker-entrypoint.sh ./apps/api/docker-entrypoint.sh
RUN chmod +x ./apps/api/docker-entrypoint.sh \
    && mkdir -p /app/storage \
    && chown -R node:node /app
EXPOSE 60557
ENTRYPOINT ["./apps/api/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]

FROM ${NGINX_IMAGE} AS web
COPY infra/nginx/default.conf /etc/nginx/templates/default.conf.template
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
# Official nginx entrypoint runs /docker-entrypoint.d/*.sh before nginx starts.
# Writing runtime-config.js here makes ADMIN_LOGIN_PATH restart-effective.
COPY apps/web/docker-entrypoint.sh /docker-entrypoint.d/40-ufm-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-ufm-runtime-config.sh
EXPOSE 80
