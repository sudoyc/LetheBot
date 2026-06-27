FROM node:22-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Create app directory
WORKDIR /app

# Copy dependency files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm build

# Create data directory
RUN mkdir -p /app/data

# Expose health check port (optional)
EXPOSE 8080

# Run the application
CMD ["node", "dist/index.js"]
