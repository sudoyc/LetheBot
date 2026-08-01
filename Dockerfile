FROM node:22-alpine AS build

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Create app directory
WORKDIR /app

# Copy dependency files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy only build inputs
COPY tsconfig.json ./
COPY LICENSE README.md ./
COPY src ./src
COPY migrations ./migrations

# Build and validate the runtime layout
RUN pnpm build
RUN pnpm release:preflight
RUN pnpm release:pack-check

# Keep only runtime dependencies for the final image
RUN pnpm prune --prod
RUN node --input-type=module --eval "await import('./dist/scripts/verify-napcat.js')"

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV LETHEBOT_HOST=0.0.0.0

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/README.md ./README.md

# Create a private data directory for the image default runtime identity.
RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 700 /app/data

USER node

# Expose the default LetheBot HTTP port
EXPOSE 6700

# Run the application
CMD ["sh", "-c", "umask 077 && exec node dist/index.js"]
