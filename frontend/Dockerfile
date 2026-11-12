# Build context: repository root (npm workspaces)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend --include-workspace-root
COPY frontend frontend
ARG VITE_API_URL=http://localhost:4000
ARG VITE_ADMIN_KEY=change-me-admin-key
ENV VITE_API_URL=$VITE_API_URL VITE_ADMIN_KEY=$VITE_ADMIN_KEY
RUN npm run build --workspace frontend

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
