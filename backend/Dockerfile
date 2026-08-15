FROM node:22-alpine AS deps
# better-sqlite3 (via @happy/pay) is a native module with no alpine prebuild.
RUN apk add --no-cache python3 make g++ && npm install --global pnpm@11.1.3
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY backend/package.json backend/package.json
COPY packages/pay/package.json packages/pay/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/closer/package.json packages/closer/package.json
# One image serves both containers in the task: the backend and the Closer sidecar.
RUN pnpm install --filter @happy/backend... --filter @happy/closer... --frozen-lockfile

FROM node:22-alpine AS runtime
RUN npm install --global pnpm@11.1.3
WORKDIR /app
ENV NODE_ENV=production
# Every node_modules tree the install produced, workspace links included.
COPY --from=deps /app ./
# The backend imports @happy/pay from source, so its workspace packages ship with it.
COPY packages/pay ./packages/pay
COPY packages/shared ./packages/shared
COPY packages/closer ./packages/closer
COPY backend ./backend
WORKDIR /app/backend
EXPOSE 8787
CMD ["pnpm", "start"]
