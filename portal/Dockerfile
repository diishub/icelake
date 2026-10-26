# Builds the portal to static files, then serves them with the same nginx the
# hand-written portal used. Node exists only in the build stage: nothing in
# the running container executes JavaScript server-side.
FROM node:22.23.2-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# The npm cache survives between builds (BuildKit cache mount), and slow or
# flaky registry connections get retried instead of failing the build.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --prefer-offline \
      --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000
COPY . .
RUN npm run build

FROM nginx:1.29.1-alpine
COPY --from=build /app/out /usr/share/nginx/html
