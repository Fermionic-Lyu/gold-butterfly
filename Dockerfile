# Build the Vite bundle and the server, then ship only the runtime output.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/data ./data
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["node", "dist-server/index.js"]
