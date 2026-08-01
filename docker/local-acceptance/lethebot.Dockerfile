FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY LICENSE README.md ./
COPY src ./src
COPY migrations ./migrations

RUN pnpm build
RUN pnpm release:preflight
RUN pnpm release:pack-check
RUN pnpm prune --prod
RUN node --input-type=module --eval "await import('./dist/scripts/verify-napcat.js')"

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV LETHEBOT_HOST=0.0.0.0

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/README.md ./README.md

RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 700 /app/data

USER node

EXPOSE 6700

CMD ["sh", "-c", "umask 077 && exec node dist/index.js"]
