FROM node:24-alpine
# ffmpeg and ffprobe transcode untrusted feedback video; sharp brings its own libvips.
RUN apk add --no-cache ffmpeg
WORKDIR /bridge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bridge.ts ./bridge.ts
USER node
CMD ["node", "bridge.ts"]
