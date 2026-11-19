import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type Sharp from "sharp";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { forbidden, maxInputBytes } from "../bridge/sanitizer.ts";
import { mediaStubs, sanitizerToken, spawnSanitizer, startSanitizer } from "./sanitizerProcess.ts";

// The bridge owns its sharp install; tests use the same copy to make and inspect images.
const sharp = createRequire(fileURLToPath(new URL("../bridge/package.json", import.meta.url)))("sharp") as typeof Sharp;
let stubs: Awaited<ReturnType<typeof mediaStubs>>;
let sanitizer: Awaited<ReturnType<typeof startSanitizer>>;
beforeAll(async () => {
  stubs = await mediaStubs();
  sanitizer = await startSanitizer(stubs.path);
});
afterAll(async () => {
  await sanitizer?.stop();
  await stubs?.remove();
});
beforeEach(async () => { await stubs.reset(); });

async function sanitize(data: Buffer, type: string, token = sanitizerToken) {
  const response = await fetch(`${sanitizer.url}/v1/sanitize?type=${encodeURIComponent(type)}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: Uint8Array.from(data),
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, type: response.headers.get("content-type"), digest: response.headers.get("x-content-sha256"), body };
}

async function kept(data: Buffer, type: string) {
  const result = await sanitize(data, type);
  expect(result.status).toBe(200);
  expect(result.digest).toBe(createHash("sha256").update(result.body).digest("hex"));
  // Every request's staged files are gone once it answers.
  expect(await readdir(sanitizer.temp)).toEqual([]);
  return result;
}

async function dropped(data: Buffer, type: string) {
  const result = await sanitize(data, type);
  expect([result.status, result.type]).toEqual([200, "application/json"]);
  return (JSON.parse(result.body.toString()) as { dropped: string }).dropped;
}

const image = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#c33" } });

it.each(forbidden)("refuses to start with %s, naming it without its value", async (name) => {
  const child = spawnSanitizer({ SANITIZER_TOKEN: sanitizerToken, SANITIZER_PORT: "0", PATH: stubs.path, [name]: "synthetic-forbidden-value" });
  const started = await child.started;
  await child.stop();
  expect(started).toEqual({ code: 2 });
  expect(child.output()).toContain(name);
  expect(child.output()).not.toContain("synthetic-forbidden-value");
});

it("refuses to start without SANITIZER_TOKEN", async () => {
  const child = spawnSanitizer({ SANITIZER_PORT: "0", PATH: stubs.path });
  const started = await child.started;
  await child.stop();
  expect(started).toEqual({ code: 2 });
  expect(child.output()).toContain("missing SANITIZER_TOKEN");
});

it("admits the type limits Relay enforces", async () => {
  const limits = JSON.parse(await readFile(new URL("../../contracts/fixtures/feedback-attachment-limits.json", import.meta.url), "utf8")) as {
    types: Record<string, { maxBytes: number }>;
  };
  expect(maxInputBytes).toEqual(Object.fromEntries(Object.entries(limits.types).map(([type, { maxBytes }]) => [type, maxBytes])));
});

it("answers only an authorized sanitize request within its type's byte limit", async () => {
  const png = await image(20, 20).png().toBuffer();
  expect((await sanitize(png, "image/png", "wrong-token")).status).toBe(401);
  expect((await fetch(`${sanitizer.url}/v1/sanitize?type=image%2Fpng`, { method: "POST", body: Uint8Array.from(png) })).status).toBe(401);
  expect((await fetch(`${sanitizer.url}/v1/other`, { method: "POST", headers: { authorization: `Bearer ${sanitizerToken}` } })).status).toBe(404);
  const health = await fetch(`${sanitizer.url}/healthz`);
  expect([health.status, await health.text()]).toEqual([200, "ok"]);
  // A declared length over the type's limit is refused before any byte is read.
  const oversized = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${sanitizer.url}/v1/sanitize?type=image%2Fpng`, {
      method: "POST", headers: { authorization: `Bearer ${sanitizerToken}`, "content-length": maxInputBytes["image/png"]! + 1 },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.flushHeaders();
  });
  expect(oversized).toBe(413);
  expect((await kept(png, "image/png")).type).toBe("image/png");
});

it("re-encodes images without EXIF, GPS or XMP, fitting them inside 2560×2560", async () => {
  const jpeg = await image(64, 48)
    .withExif({ IFD0: { Copyright: "synthetic" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
      + '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="synthetic-creator"/></rdf:RDF></x:xmpmeta>')
    .jpeg().toBuffer();
  const before = await sharp(jpeg).metadata();
  // The GPS IFD pointer (tag 0x8825) proves the input really carries a location.
  expect(before.exif?.includes(Buffer.from([0x88, 0x25])) || before.exif?.includes(Buffer.from([0x25, 0x88]))).toBe(true);
  expect(before.xmp).toBeDefined();
  const cleaned = await kept(jpeg, "image/jpeg");
  expect(cleaned.type).toBe("image/jpeg");
  const metadata = await sharp(cleaned.body).metadata();
  expect(metadata).toMatchObject({ format: "jpeg", width: 64, height: 48 });
  expect(metadata.exif).toBeUndefined();
  expect(metadata.xmp).toBeUndefined();
  expect(cleaned.body.includes("synthetic-creator")).toBe(false);
  expect(await sharp((await kept(await image(3000, 1000).png().toBuffer(), "image/png")).body).metadata())
    .toMatchObject({ format: "png", width: 2560, height: 853 });
  // A 48 MP phone photo is kept and downscaled.
  expect(await sharp((await kept(await image(8064, 6048).jpeg().toBuffer(), "image/jpeg")).body).metadata())
    .toMatchObject({ format: "jpeg", width: 2560, height: 1920 });
  expect((await kept(await image(30, 20).webp().toBuffer(), "image/webp")).type).toBe("image/jpeg");
});

it("drops unsafe or unusable attachments with a fixed reason", async () => {
  expect(await dropped(await image(10001, 10000).png().toBuffer(), "image/png")).toBe("too large");
  expect(await dropped(Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("<html>")]), "image/png")).toBe("failed validation");
  expect(await dropped(Buffer.from("LONG synthetic clip"), "video/mp4")).toBe("too long");
  expect(await dropped(Buffer.from("not an image at all"), "toString")).toBe("failed validation");
  expect(await readdir(sanitizer.temp)).toEqual([]);
});

it("transcodes video with fixed, file-only ffmpeg arguments to a silent MP4 without metadata", async () => {
  const video = await kept(Buffer.from("synthetic clip"), "video/quicktime");
  expect(video.type).toBe("video/mp4");
  const ffmpeg = JSON.parse(video.body.toString()) as string[];
  expect(ffmpeg.slice(0, 7)).toEqual(["-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mov"]);
  for (const flags of [["-map", "0:v:0"], ["-an"], ["-map_metadata", "-1"], ["-c:v", "libx264"], ["-maxrate", "2500000"], ["-bufsize", "5000000"]]) {
    expect(ffmpeg.join("\n")).toContain(flags.join("\n"));
  }
  expect((JSON.parse((await kept(Buffer.from("synthetic clip"), "video/webm")).body.toString()) as string[]).slice(5, 7)).toEqual(["-f", "matroska"]);
});

it("decodes HEIC photos with ffmpeg, scaling the primary tile grid while decoding, and returns sanitized JPEG", async () => {
  const heic = async (prefix: string) => Buffer.concat([Buffer.from(prefix), await image(40, 30).png().toBuffer()]);
  for (const prefix of ["FAKEHEIC", "GRIDHEIC", "GAINHEIC"]) {
    const result = await kept(await heic(prefix), "image/heic");
    expect(result.type).toBe("image/jpeg");
    expect(await sharp(result.body).metadata()).toMatchObject({ format: "jpeg", width: 40, height: 30 });
  }
  expect(await dropped(Buffer.from("HUGE synthetic heic"), "image/heic")).toBe("too large");
  // The oversized grid is refused from its probe alone, before any decode.
  const decode = (input: string) => [
    "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-i", expect.stringMatching(/\/input$/),
    "-filter_complex", `${input}scale=2560:2560:force_original_aspect_ratio=decrease[out]`, "-map", "[out]",
    "-frames:v", "1", "-update", "1", "-map_metadata", "-1", "-pix_fmt", "rgb24", expect.stringMatching(/\/decoded\.png$/),
  ];
  expect(await stubs.calls()).toEqual([decode("[0:v:0]"), decode("[0:g:0]"), decode("[0:g:1]")]);
});
