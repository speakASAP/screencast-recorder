FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# The operator console is static and lives beside dist/, not inside it: nest
# build emits only compiled TypeScript. ServeStaticModule resolves it as
# __dirname/../public, so this path is load-bearing.
COPY --from=build /app/public ./public

# Migrations are not run at container start. The app must not mutate schema on
# boot: a rolling update would run it once per replica, and a failed migration
# would crash-loop the service instead of leaving the previous version serving.
# They are applied deliberately with `npm run migration:run` before the rollout.
EXPOSE 3391
CMD ["node", "dist/main.js"]
