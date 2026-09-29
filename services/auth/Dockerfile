# Build and run the portal's sign-in service.
#
# Two stages so the image that runs in the stack carries no compiler, no test
# tooling and no development dependencies -- the build agent does not ship.
FROM node:22.12.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.12.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Runs as the image's own unprivileged user rather than root.
USER node
EXPOSE 8087
CMD ["node", "dist/server.js"]
