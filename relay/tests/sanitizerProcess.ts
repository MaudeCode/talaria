import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sanitizer = fileURLToPath(new URL("../bridge/sanitizer.ts", import.meta.url));
export const sanitizerToken = "synthetic-sanitizer-token";

// Stand-ins for ffprobe and ffmpeg, found through the sanitizer's PATH. Real decoding is proven by bridge/smoke.ts
// against the built image. A file whose bytes start with LONG probes as 300 seconds, one starting with HUGE as
// 10001×10000 pixels, and one starting with GRIDHEIC or GAINHEIC as a tile grid (GAINHEIC lists a gain-map grid before
// the primary one). A PNG "decode" strips the 8-byte HEIC prefix, which sharp cannot read, from a real PNG; any other
// output is the JSON argument list. Every ffmpeg call is logged to calls.log, and every stub's environment to env.log.
export async function mediaStubs() {
  const directory = await mkdtemp(join(tmpdir(), "feedback-media-stubs-"));
  const stub = (source: string) => `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");
const args = process.argv.slice(2);\nfs.appendFileSync(path.join(__dirname, "env.log"), JSON.stringify(process.env) + "\\n");\n${source}\n`;
  await writeFile(join(directory, "ffprobe"), stub(`const input = fs.readFileSync(args.at(-1), "utf8");
const [width, height] = input.startsWith("HUGE") ? [10001, 10000] : [64, 64];
const grid = (index, primary) => ({ index, type: "Tile Grid", disposition: { default: primary ? 1 : 0 }, components: [{ width, height }] });
const groups = input.startsWith("GRIDHEIC") ? [grid(0, true)] : input.startsWith("GAINHEIC") ? [grid(0, false), grid(1, true)] : [];
process.stdout.write(JSON.stringify({ streams: [{ codec_type: "video", width, height }], stream_groups: groups,
  format: { duration: input.startsWith("LONG") ? "300" : "3.2" } }));`));
  await writeFile(join(directory, "ffmpeg"), stub(`fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n");
const output = args.at(-1);
if (output.endsWith(".png")) fs.writeFileSync(output, fs.readFileSync(args[args.indexOf("-i") + 1]).subarray(8));
else fs.writeFileSync(output, JSON.stringify(args));`));
  await Promise.all(["ffprobe", "ffmpeg"].map((name) => chmod(join(directory, name), 0o755)));
  const log = (name: string) => readFile(join(directory, name), "utf8").catch(() => "");
  return {
    path: directory,
    calls: async () => (await log("calls.log")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    environments: async () => (await log("env.log")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>),
    reset: () => Promise.all(["calls.log", "env.log"].map((name) => rm(join(directory, name), { force: true }))),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Runs `node bridge/sanitizer.ts` with exactly `env`; resolves once it listens, or with its exit when it refuses to start. */
export function spawnSanitizer(env: Record<string, string>) {
  const child = spawn(process.execPath, [sanitizer], { env });
  let output = "";
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const started = new Promise<{ url: string } | { code: number | null }>((resolve) => {
    const read = (chunk: Buffer) => {
      output += chunk;
      const port = /listening on port (\d+)/.exec(output)?.[1];
      if (port) resolve({ url: `http://127.0.0.1:${port}` });
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    void exited.then((code) => resolve({ code }));
  });
  return {
    started,
    output: () => output,
    stop: async () => {
      child.kill("SIGTERM");
      return await exited;
    },
  };
}

/** A listening sanitizer whose decoders are the stubs and whose temporary files go to its own `temp` directory. */
export async function startSanitizer(stubs: string) {
  const temp = await mkdtemp(join(tmpdir(), "feedback-sanitizer-tmp-"));
  const child = spawnSanitizer({ SANITIZER_TOKEN: sanitizerToken, SANITIZER_PORT: "0", PATH: stubs, TMPDIR: temp });
  const started = await child.started;
  if (!("url" in started)) throw new Error(`The sanitizer exited ${started.code}: ${child.output()}`);
  return {
    url: started.url, temp, output: child.output,
    stop: async () => {
      await child.stop();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
