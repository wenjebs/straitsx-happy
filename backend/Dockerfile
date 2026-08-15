FROM node:22-alpine AS deps
RUN npm install --global pnpm@11.1.3
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY backend/package.json backend/package.json
RUN pnpm install --filter @happy/backend... --frozen-lockfile

FROM node:22-alpine AS runtime
RUN npm install --global pnpm@11.1.3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY backend ./backend
WORKDIR /app/backend
EXPOSE 8787
CMD ["pnpm", "start"]
