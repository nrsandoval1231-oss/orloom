FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY dist ./dist
USER node
ENTRYPOINT ["node", "dist/apps/worker/src/main.js"]
