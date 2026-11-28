// The secret-free half of the feedback bridge: the only process that parses untrusted media. It runs as its own
// container from the bridge image (`node sanitizer.ts`), holds no Relay or Kanvil credential, and answers one
// authenticated operation: POST /v1/sanitize?type=<declared content type> with the attachment's bytes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { type DropReason, digestHeader, maxOutputBytes, type OutputType } from "./attachments.ts";
import { bearerVerifier } from "./bearer.ts";

const maxVideoSeconds = 120.5;
// Covers 48–50 MP phone sensors with headroom.
const maxInputPixels = 100_000_000;
// Mirrors the per-type byte limits Relay admits (`contracts/fixtures/feedback-attachment-limits.json`).
export const maxInputBytes: Record<string, number> = {
  "image/png": 10_000_000, "image/jpeg": 10_000_000, "image/heic": 10_000_000, "image/webp": 10_000_000,
  "video/mp4": 20_000_000, "video/quicktime": 20_000_000, "video/webm": 20_000_000,
};
const run = promisify(execFile);
const probe = (args: string[]) => run("ffprobe", ["-v", "error", ...args], { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });

type Sanitized = { contentType: OutputType; data: Buffer };
// Its message is the DropReason.
class Dropped extends Error {}

const images = new Set(["image/png", "image/jpeg", "image/heic", "image/webp"]);
// Forcing the demuxer keeps ffmpeg from treating a crafted upload as a playlist or another container.
const demuxers: Record<string, string> = { "video/mp4": "mov", "video/quicktime": "mov", "video/webm": "matroska" };

// Re-encodes an untrusted image: applies orientation, bounds its size, and drops EXIF, GPS, XMP,
// ICC and comments, which sharp never copies unless asked.
async function sanitizeImage(input: Buffer, contentType: string): Promise<Sanitized> {
  const options = { limitInputPixels: maxInputPixels, failOn: "error" } as const;
  let pixels: number;
  try {
    // Reads the header only; the pixel check below names the reason, which a decode error would not.
    const { width, height } = await sharp(input, { limitInputPixels: false }).metadata();
    pixels = width * height;
  } catch {
    throw new Dropped("failed validation");
  }
  if (!(pixels > 0)) throw new Dropped("failed validation");
  if (pixels > maxInputPixels) throw new Dropped("too large");
  const png = contentType === "image/png";
  let data: Buffer;
  try {
    const pipeline = sharp(input, options).rotate().resize(2560, 2560, { fit: "inside", withoutEnlargement: true });
    data = await (png ? pipeline.png() : pipeline.jpeg({ quality: 85 })).toBuffer();
  } catch {
    throw new Dropped("failed validation");
  }
  if (data.length > maxOutputBytes) throw new Dropped("too large");
  return { contentType: png ? "image/png" : "image/jpeg", data };
}

// sharp's bundled libvips cannot decode HEVC, so ffmpeg turns a HEIC (an iPhone tile grid, with its
// irot rotation applied) into a PNG for sanitizeImage, scaled to fit 2560×2560 while decoding so a 48 MP
// frame never reaches memory at full size. The probe refuses an oversized grid before decoding.
async function decodeHeic(input: string, output: string): Promise<Buffer> {
  const source = ["-protocol_whitelist", "file", "-f", "mov", "-i", input];
  type Size = { width?: number; height?: number };
  type Group = { index?: number; type?: string; disposition?: { default?: number }; components?: Size[] };
  let pixels: number;
  let primary: string;
  try {
    const { stdout } = await probe(["-show_stream_groups", "-show_streams", "-of", "json", ...source]);
    const parsed = JSON.parse(stdout) as { streams?: Size[]; stream_groups?: Group[] };
    const sizes = [...parsed.streams ?? [], ...(parsed.stream_groups ?? []).flatMap((group) => group.components ?? [])];
    pixels = Math.max(0, ...sizes.map(({ width = 0, height = 0 }) => width * height));
    // The primary grid carries the default disposition; an HDR gain map is a second, non-default grid.
    const grids = (parsed.stream_groups ?? []).filter((group) => group.type === "Tile Grid");
    const grid = grids.find((group) => group.disposition?.default) ?? grids[0];
    if (grid && !Number.isSafeInteger(grid.index)) throw new Error();
    primary = grid ? `[0:g:${grid.index}]` : "[0:v:0]";
  } catch {
    throw new Dropped("failed validation");
  }
  if (!(pixels > 0)) throw new Dropped("failed validation");
  if (pixels > maxInputPixels) throw new Dropped("too large");
  try {
    // -vf and -s lose the rotation or the grid's size, so the scale runs in a complex filtergraph.
    await run("ffmpeg", [
      "-nostdin", "-v", "error", ...source, "-filter_complex", `${primary}scale=2560:2560:force_original_aspect_ratio=decrease[out]`,
      "-map", "[out]", "-frames:v", "1", "-update", "1", "-map_metadata", "-1", "-pix_fmt", "rgb24", output,
    ], { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
    return await readFile(output);
  } catch {
    throw new Dropped("failed validation");
  }
}

// Transcodes an untrusted clip to a silent H.264 MP4 without metadata that fits Kanvil's limit.
async function sanitizeVideo(input: string, output: string, contentType: string): Promise<Sanitized> {
  const source = ["-protocol_whitelist", "file", "-f", demuxers[contentType]!, "-i", input];
  let duration: number;
  try {
    const { stdout } = await probe(["-show_entries", "stream=codec_type:format=duration", "-of", "json", ...source]);
    const parsed = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
    if (parsed.streams?.filter((stream) => stream.codec_type === "video").length !== 1) throw new Error();
    duration = Number(parsed.format?.duration);
  } catch {
    throw new Dropped("failed validation");
  }
  if (!(duration > 0)) throw new Dropped("failed validation");
  if (duration > maxVideoSeconds) throw new Dropped("too long");
  const rate = Math.min(2_500_000, Math.floor(9_000_000 * 8 / duration));
  try {
    await run("ffmpeg", [
      "-nostdin", "-v", "error", ...source, "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
      "-vf", "scale='min(1280,trunc(iw/2)*2)':-2", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
      "-maxrate", `${rate}`, "-bufsize", `${rate * 2}`, "-movflags", "+faststart", output,
    ], { timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 1_000_000 });
  } catch {
    throw new Dropped("failed validation");
  }
  const data = await readFile(output);
  if (data.length > maxOutputBytes) throw new Dropped("too large");
  return { contentType: "video/mp4", data };
}

// One declared attachment, staged in its own directory because ffmpeg reads files, never a buffer.
async function sanitize(input: Buffer, contentType: string, directory: string): Promise<Sanitized> {
  const staged = async () => {
    const source = join(directory, "input");
    await writeFile(source, input);
    return source;
  };
  if (contentType === "image/heic") return await sanitizeImage(await decodeHeic(await staged(), join(directory, "decoded.png")), contentType);
  if (images.has(contentType)) return await sanitizeImage(input, contentType);
  if (Object.hasOwn(demuxers, contentType)) return await sanitizeVideo(await staged(), join(directory, "output.mp4"), contentType);
  throw new Dropped("failed validation");
}

/**
 * `POST /v1/sanitize?type=<declared type>` with the bearer token and the raw attachment answers 200 with either the
 * cleaned bytes (`content-type` and `x-content-sha256` set) or `{"dropped": <reason>}` JSON. A wrong token is 401, a
 * body without a length or over its type's limit 413, a request while another runs 503. `GET /healthz` is 200.
 */
export function serveSanitizer(token: string, port: number): Promise<Server> {
  const verifyBearer = bearerVerifier(token);
  let busy = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://sanitizer");
    if (request.method === "GET" && url.pathname === "/healthz") return void response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    // Nothing else reads the body, so every refusal closes the connection instead of draining it.
    const refuse = (status: number) => void response.writeHead(status, { connection: "close" }).end();
    if (request.method !== "POST" || url.pathname !== "/v1/sanitize") return refuse(404);
    if (!verifyBearer(request.headers.authorization)) return refuse(401);
    const contentType = url.searchParams.get("type") ?? "";
    const length = Number(request.headers["content-length"]);
    // An unknown type is read within the largest limit and dropped as failed validation.
    const limit = Object.hasOwn(maxInputBytes, contentType) ? maxInputBytes[contentType]! : Math.max(...Object.values(maxInputBytes));
    if (!Number.isSafeInteger(length) || length < 1 || length > limit) return refuse(413);
    if (busy) return refuse(503);
    busy = true;
    let result: Sanitized | { dropped: DropReason };
    try {
      // Node's parser stops at the declared length, so the buffer never exceeds the limit checked above.
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const input = Buffer.concat(chunks);
      if (input.length !== length) return refuse(400);
      const directory = await mkdtemp(join(tmpdir(), "sanitize-"));
      try {
        result = await sanitize(input, contentType, directory);
      } catch (error) {
        if (!(error instanceof Dropped)) throw error;
        result = { dropped: error.message as DropReason };
      } finally {
        // Removed before answering, so no staged file outlives its request.
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      busy = false;
    }
    if ("dropped" in result) return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    response.writeHead(200, {
      "content-type": result.contentType, "content-length": result.data.length,
      [digestHeader]: createHash("sha256").update(result.data).digest("hex"),
    }).end(result.data);
  };
  const server = createServer((request, response) => {
    // Never log the error: it can echo the request.
    void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500, { connection: "close" }).end(); });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

// The bridge's Relay and Kanvil configuration. A decoder compromise here must not reach any of it.
export const forbidden = ["RELAY_URL", "RELAY_SYNC_URL", "FEEDBACK_OPERATOR_TOKEN", "KANVIL_URL", "KANVIL_INTAKE_KEY", "KANVIL_PROJECT_ID"];

// Exit code 2 for a forbidden, missing or invalid variable, naming only the variable.
async function main(): Promise<number> {
  for (const name of forbidden) {
    if (name in process.env) {
      console.error(`Feedback sanitizer: refusing to start with ${name}; it belongs only to the bridge`);
      return 2;
    }
  }
  const token = process.env.SANITIZER_TOKEN?.trim();
  if (!token) {
    console.error("Feedback sanitizer: missing SANITIZER_TOKEN");
    return 2;
  }
  // ffmpeg and ffprobe inherit this environment; they never need the token.
  delete process.env.SANITIZER_TOKEN;
  const port = process.env.SANITIZER_PORT?.trim() || "8080";
  if (!/^(0|[1-9][0-9]{0,4})$/.test(port) || Number(port) > 65_535) {
    console.error("Feedback sanitizer: invalid SANITIZER_PORT");
    return 2;
  }
  const server = await serveSanitizer(token, Number(port));
  const address = server.address();
  console.log(`Feedback sanitizer: listening on port ${typeof address === "object" && address ? address.port : port}`);
  await new Promise((resolve) => process.once("SIGTERM", resolve));
  await new Promise((resolve) => server.close(resolve));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
