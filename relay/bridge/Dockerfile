FROM node:24-alpine
WORKDIR /bridge
COPY --chown=node:node bridge.ts ./bridge.ts
USER node
CMD ["node", "bridge.ts"]
