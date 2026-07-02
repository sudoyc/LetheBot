FROM node:22-bookworm-slim AS build

WORKDIR /snowluma

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:all

FROM node:22-bookworm-slim

WORKDIR /snowluma

ENV NODE_ENV=production \
    SNOWLUMA_WEBUI_HOST=0.0.0.0 \
    SNOWLUMA_WEBUI_PORT=5099 \
    SNOWLUMA_WEBUI_TRUST_PROXY=0 \
    SNOWLUMA_LOG_DIR=/snowluma/logs \
    SNOWLUMA_LOG_FILE=1 \
    SNOWLUMA_HOOK_AUTOLOAD=0 \
    SNOWLUMA_UPDATE_CHECK=0

COPY --from=build /snowluma/dist ./dist
RUN mkdir -p /snowluma/config /snowluma/data /snowluma/logs

EXPOSE 5099 3000 3001

CMD ["node", "dist/index.mjs"]
