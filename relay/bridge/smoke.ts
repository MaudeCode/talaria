// Proves real sanitization by the image's sanitizer mode: build-image.sh runs `node sanitizer.ts` in one container
// (read-only root, bounded /tmp, no outbound network) and `node smoke.ts` in another, which reaches it at
// SANITIZER_URL with SANITIZER_TOKEN. Unit tests stub ffmpeg; this runs the image's own sharp and ffmpeg.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { digestHeader, maxOutputBytes } from "./attachments.ts";

const run = promisify(execFile);
const { SANITIZER_URL: url, SANITIZER_TOKEN: token } = process.env;
assert.ok(url && token);

// The sanitizer container starts in parallel; wait up to 30 seconds for it to listen.
for (let attempt = 0; ; attempt += 1) {
  if (await fetch(`${url}/healthz`).then((response) => response.ok, () => false)) break;
  assert.ok(attempt < 60, "the sanitizer never became healthy");
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function sanitize(input: Buffer, type: string) {
  const response = await fetch(`${url}/v1/sanitize?type=${encodeURIComponent(type)}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: Uint8Array.from(input),
  });
  assert.equal(response.status, 200);
  const contentType = response.headers.get("content-type");
  const data = Buffer.from(await response.arrayBuffer());
  if (contentType === "application/json") return { dropped: (JSON.parse(data.toString()) as { dropped: string }).dropped };
  assert.equal(response.headers.get(digestHeader), createHash("sha256").update(data).digest("hex"));
  return { contentType, data };
}

const marker = "synthetic-smoke-location";
const directory = await mkdtemp(join(tmpdir(), "bridge-smoke-"));
try {
  const refused = await fetch(`${url}/v1/sanitize?type=image%2Fpng`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "x" });
  assert.equal(refused.status, 401);

  const jpeg = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#36c" } })
    .withExif({ IFD0: { Copyright: marker }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
    .withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="${marker}"/></rdf:RDF></x:xmpmeta>`)
    .jpeg().toBuffer();
  assert.ok((await sharp(jpeg).metadata()).exif);
  const image = await sanitize(jpeg, "image/jpeg");
  assert.ok(image.data);
  const cleaned = await sharp(image.data).metadata();
  assert.equal(cleaned.exif, undefined);
  assert.equal(cleaned.xmp, undefined);
  assert.equal(image.data.includes(marker), false);
  assert.deepEqual([image.contentType, cleaned.format, cleaned.width, cleaned.height], ["image/jpeg", "jpeg", 2560, 1920]);

  // A synthetic 48 MP iPhone-style HEIC: an 8064×6048 tile grid with an irot rotation of −90° and EXIF GPS,
  // made with ImageIO from ffmpeg testsrc2 pixels. It decodes straight to the 2560 px bound.
  const heicMarker = "synthetic-heic-marker";
  const heicBytes = await readFile(join(import.meta.dirname, "fixtures", "rotated-gps.heic"));
  assert.ok(heicBytes.includes(heicMarker));
  const heic = await sanitize(heicBytes, "image/heic");
  assert.ok(heic.data);
  const heicCleaned = await sharp(heic.data).metadata();
  assert.deepEqual([heic.contentType, heicCleaned.format, heicCleaned.width, heicCleaned.height], ["image/jpeg", "jpeg", 1920, 2560]);
  assert.equal(heicCleaned.exif, undefined);
  assert.equal(heicCleaned.xmp, undefined);
  assert.equal(heic.data.includes(heicMarker), false);

  const clip = async (name: string, seconds: number, codecs: string[]) => {
    const path = join(directory, name);
    await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=1920x1080:rate=30:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=duration=${seconds}`, "-metadata", `title=${marker}`, "-metadata", `location=${marker}`,
      ...codecs, path]);
    return await readFile(path);
  };
  const clips = [
    ["video/mp4", await clip("in.mp4", 2, ["-c:v", "libx264", "-c:a", "aac"])],
    ["video/webm", await clip("in.webm", 2, ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-c:a", "libopus"])],
  ] as const;
  for (const [index, [contentType, input]] of clips.entries()) {
    const video = await sanitize(input, contentType);
    assert.ok(video.data);
    assert.equal(video.contentType, "video/mp4");
    assert.ok(video.data.length <= maxOutputBytes);
    assert.equal(video.data.includes(marker), false);
    const output = join(directory, `out-${index}.mp4`);
    await writeFile(output, video.data);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]);
    const probe = JSON.parse(stdout) as { streams: Array<{ codec_type: string; codec_name: string; width: number }>; format: { duration: string; tags?: Record<string, string> } };
    assert.deepEqual(probe.streams.map((stream) => [stream.codec_type, stream.codec_name, stream.width]), [["video", "h264", 1280]]);
    assert.ok(Number(probe.format.duration) <= 120.5);
    assert.equal(stdout.includes(marker), false);
    assert.equal(probe.format.tags?.title, undefined);
  }
  const long = await clip("long.mp4", 125, ["-s", "64x64", "-r", "2", "-c:v", "libx264", "-c:a", "aac"]);
  assert.deepEqual(await sanitize(long, "video/mp4"), { dropped: "too long" });
  console.log("Feedback bridge smoke: the sanitizer container's sharp and ffmpeg sanitization verified");
} finally {
  await rm(directory, { recursive: true, force: true });
}
