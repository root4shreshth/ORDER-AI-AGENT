# Build context: repository root (npm workspaces)
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace backend --include-workspace-root
COPY backend backend
RUN npm run build --workspace backend

FROM node:22-alpine
RUN apk add --no-cache openssl wget
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/backend ./backend
WORKDIR /app/backend
EXPOSE 4000
CMD ["node", "dist/src/server.js"]
