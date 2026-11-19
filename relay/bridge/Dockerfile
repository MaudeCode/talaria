# Pinned by digest like the Web image; web/docs/docker.md has the bump procedure.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# ffmpeg and ffprobe transcode untrusted feedback video in sanitizer mode; sharp brings its own libvips.
RUN apk add --no-cache ffmpeg
WORKDIR /bridge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY attachments.ts bridge.ts sanitizer.ts ./
USER node
# Bridge mode. `node sanitizer.ts` selects sanitizer mode, which runs as its own secret-free container.
CMD ["node", "bridge.ts"]
