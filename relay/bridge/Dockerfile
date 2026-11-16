# Pinned by digest like the Web image; web/docs/docker.md has the bump procedure.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# ffmpeg and ffprobe transcode untrusted feedback video; sharp brings its own libvips.
RUN apk add --no-cache ffmpeg
WORKDIR /bridge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bridge.ts ./bridge.ts
USER node
CMD ["node", "bridge.ts"]
