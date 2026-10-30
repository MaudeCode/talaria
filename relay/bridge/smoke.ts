// Proves real sanitization inside the built image: `node smoke.ts` from the bridge directory.
// Unit tests stub ffmpeg; this runs the image's own sharp and ffmpeg on synthetic media.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { decodeHeic, maxOutputBytes, sanitizeImage, sanitizeVideo } from "./bridge.ts";

const run = promisify(execFile);
const marker = "synthetic-smoke-location";
const directory = await mkdtemp(join(tmpdir(), "bridge-smoke-"));
try {
  const jpeg = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#36c" } })
    .withExif({ IFD0: { Copyright: marker }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
    .withXmp(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="${marker}"/></rdf:RDF></x:xmpmeta>`)
    .jpeg().toBuffer();
  assert.ok((await sharp(jpeg).metadata()).exif);
  const image = await sanitizeImage(jpeg, "image/jpeg", 0);
  const cleaned = await sharp(image.data).metadata();
  assert.equal(cleaned.exif, undefined);
  assert.equal(cleaned.xmp, undefined);
  assert.equal(image.data.includes(marker), false);
  assert.deepEqual([cleaned.format, cleaned.width, cleaned.height], ["jpeg", 2560, 1920]);

  // A synthetic iPhone-style HEIC: a 1600×1200 tile grid with an irot rotation of 90° and EXIF GPS.
  const heicMarker = "synthetic-heic-marker";
  const heicPath = join(import.meta.dirname, "fixtures", "rotated-gps.heic");
  assert.ok((await readFile(heicPath)).includes(heicMarker));
  const heic = await sanitizeImage(await decodeHeic(heicPath, join(directory, "heic.png")), "image/heic", 1);
  const heicCleaned = await sharp(heic.data).metadata();
  assert.deepEqual([heic.name, heicCleaned.format, heicCleaned.width, heicCleaned.height], ["attachment-1.jpg", "jpeg", 1200, 1600]);
  assert.equal(heicCleaned.exif, undefined);
  assert.equal(heicCleaned.xmp, undefined);
  assert.equal(heic.data.includes(heicMarker), false);

  const clip = async (name: string, seconds: number, codecs: string[]) => {
    const path = join(directory, name);
    await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=1920x1080:rate=30:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=duration=${seconds}`, "-metadata", `title=${marker}`, "-metadata", `location=${marker}`,
      ...codecs, path]);
    return path;
  };
  const clips = [
    ["video/mp4", await clip("in.mp4", 2, ["-c:v", "libx264", "-c:a", "aac"])],
    ["video/webm", await clip("in.webm", 2, ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-c:a", "libopus"])],
  ] as const;
  for (const [index, [contentType, path]] of clips.entries()) {
    const video = await sanitizeVideo(path, join(directory, `out-${index}.mp4`), contentType, index);
    assert.equal(video.name, `attachment-${index}.mp4`);
    assert.ok(video.data.length <= maxOutputBytes);
    assert.equal(video.data.includes(marker), false);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", join(directory, `out-${index}.mp4`)]);
    const probe = JSON.parse(stdout) as { streams: Array<{ codec_type: string; codec_name: string; width: number }>; format: { duration: string; tags?: Record<string, string> } };
    assert.deepEqual(probe.streams.map((stream) => [stream.codec_type, stream.codec_name, stream.width]), [["video", "h264", 1280]]);
    assert.ok(Number(probe.format.duration) <= 120.5);
    assert.equal(stdout.includes(marker), false);
    assert.equal(probe.format.tags?.title, undefined);
  }
  const long = await clip("long.mp4", 125, ["-s", "64x64", "-r", "2", "-c:v", "libx264", "-c:a", "aac"]);
  await assert.rejects(sanitizeVideo(long, join(directory, "long-out.mp4"), "video/mp4", 3), { message: "too long" });
  console.log("Feedback bridge smoke: sharp and ffmpeg sanitization verified");
} finally {
  await rm(directory, { recursive: true, force: true });
}
