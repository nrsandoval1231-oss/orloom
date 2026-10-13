FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --chown=10001:10001 db/migrations ./db/migrations
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/apps/control-plane/src/main.js"]
