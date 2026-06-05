# Dev Brain — multi-stage Dockerfile (T-38)
# 1) 依赖与构建
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY config ./config
RUN pnpm build

# 2) 运行时（精简）
FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config
# 数据卷：postmortem + audit log
RUN mkdir -p /var/lib/dev-brain/postmortem
VOLUME ["/var/lib/dev-brain"]

ENV NODE_ENV=production
ENV DEV_BRAIN_DEBUG=0
# 需要挂载 .env（含飞书凭证）→  /app/.env
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health',r=>process.exit(r.statusCode===200?0:1))" || exit 1
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]
