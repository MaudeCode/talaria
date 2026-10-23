import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const orientations = ['portrait', 'landscape_right', 'portrait_upside_down', 'landscape_left'];
const angles = { closed: 0, book: 90, open: 180 };
const fail = (message, exitCode = 4) => Object.assign(new Error(message), { exitCode });

export function selectDevice(devices, selector) {
  const candidates = Object.values(devices).flat().filter(device =>
    device.state === 'Booted' && device.isAvailable !== false &&
    device.deviceTypeIdentifier === 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo' &&
    (selector === 'booted' || device.udid.toLowerCase() === selector.toLowerCase()));
  if (candidates.length !== 1) throw fail('Select exactly one booted iPhone Duo by UDID.', 3);
  return candidates[0].udid;
}

export function hubUrl(override = process.env.DUO_POSE_HUB_URL) {
  if (!override) {
    try {
      const hub = JSON.parse(readFileSync(join(homedir(), '.t3/userdata/device/agent-device/hub.json'), 'utf8'));
      if (!Number.isInteger(hub.pid) || !Number.isInteger(hub.port) || hub.port < 1 || hub.port > 65535) throw Error();
      process.kill(hub.pid, 0);
      override = `http://127.0.0.1:${hub.port}`;
    } catch { throw fail('Open a simulator in T3 first, or set DUO_POSE_HUB_URL to its running local hub.', 2); }
  }
  let url;
  try { url = new URL(override); } catch { throw fail('Invalid DUO_POSE_HUB_URL.', 2); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fail('DUO_POSE_HUB_URL must be a plain HTTP loopback origin without credentials.', 2);
  }
  return url.origin;
}

function validState(state) {
  return state && [1, 3].includes(state.screenId) && orientations.includes(state.orientation) &&
    Number.isInteger(state.width) && state.width > 0 && Number.isInteger(state.height) && state.height > 0 &&
    (state.hingeAngle === undefined || Number.isFinite(state.hingeAngle) && state.hingeAngle >= 0 && state.hingeAngle <= 180);
}

function reached(state, pose) {
  // An orientation-locked app may keep its framebuffer while the native sensor rotates.
  const rotatedRight = state.physicalOrientation === undefined ? state.orientation === 'landscape_right' :
    state.physicalOrientation === 'landscape-right';
  if (pose === 'rotate-right') return rotatedRight &&
    Number.isFinite(state.hingeAngle) && state.screenId === (state.hingeAngle === 0 ? 1 : 3);
  return state.hingePose === pose && state.hingeAngle === angles[pose] &&
    state.screenId === (pose === 'closed' ? 1 : 3);
}

// shortcut: T3's private 0.15.3 framing; replace when a public pose API exposes native readback.
export async function controlDuo(origin, device, pose, timeoutMs = 10_000) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/vendor/serve-sim/helper/ws?device=${encodeURIComponent(device)}`);
  socket.binaryType = 'arraybuffer';
  return await new Promise((resolveResult, reject) => {
    let state, admitted = false, sent = false, acknowledged = false, fresh = false, done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolveResult({ ...state, changed: sent });
    };
    const timer = setTimeout(() => finish(fail(`Pose was not verified before the deadline. Last native state: ${JSON.stringify(state && {
      screenId: state.screenId, hingeAngle: state.hingeAngle, hingePose: state.hingePose,
      orientation: state.orientation, physicalOrientation: state.physicalOrientation,
    })}`)), timeoutMs);
    socket.addEventListener('error', () => finish(fail('T3 simulator input is unavailable.', 2)));
    socket.addEventListener('close', () => finish(fail('T3 simulator input disconnected before verification.')));
    socket.addEventListener('message', event => {
      if (done) return;
      const bytes = new Uint8Array(event.data);
      try {
        if (bytes[0] === 0x83) admitted = true;
        if (bytes[0] === 0x82) {
          const next = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if (!validState(next)) throw fail('T3 returned malformed simulator state.');
          if (next.inputUnavailable || next.supportsHingeAngle !== true) throw fail('T3 does not expose Duo hinge input.', 2);
          state = next;
          if (sent) fresh = true;
        }
        if (bytes[0] === 0x90) {
          const reply = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if (sent && pose !== 'rotate-right' && reply.requestId === 1) {
            if (reply.ok !== true) throw fail('T3 refused the requested pose.');
            acknowledged = true;
          }
        }
        if (sent) {
          if (fresh && (acknowledged || pose === 'rotate-right') && reached(state, pose)) finish();
          return;
        }
        if (!admitted || !state) return;
        if (reached(state, pose)) return finish();
        sent = true;
        const orientation = pose === 'rotate-right';
        const payload = orientation ? { orientation: 'landscape_right' } : { requestId: 1, command: { control: 'pose', value: pose } };
        socket.send(Buffer.concat([Buffer.from([orientation ? 0x07 : 0x10]), Buffer.from(JSON.stringify(payload))]));
      } catch (error) { finish(error.exitCode ? error : fail('T3 returned an invalid input packet.')); }
    });
  });
}

export function validatePng(png, screenId) {
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.toString('ascii', 12, 16) !== 'IHDR') throw fail('simctl did not return a PNG.');
  const actual = [png.readUInt32BE(16), png.readUInt32BE(20)].sort((a, b) => a - b);
  const expected = screenId === 1 ? [1398, 2034] : [2007, 2853];
  if (actual.some((value, index) => value !== expected[index])) throw fail('Screenshot dimensions do not match the active Duo panel.');
}

async function main(args) {
  const [selector, pose, option, path] = args;
  if (![2, 4].includes(args.length) || ![...Object.keys(angles), 'rotate-right'].includes(pose) ||
      args.length === 4 && (option !== '--screenshot' || !path) ||
      selector !== 'booted' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector)) {
    throw fail('Usage: scripts/duo-pose <udid|booted> <open|closed|book|rotate-right> [--screenshot <path>]', 64);
  }
  let device;
  try { device = selectDevice(JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { timeout: 5000 })).devices, selector); }
  catch (error) { throw error.exitCode ? error : fail('Cannot list available simulators with xcrun simctl.', 3); }
  const origin = hubUrl();
  const controller = new AbortController();
  try {
    // Match T3's capture bootstrap so a newly booted simulator publishes native state.
    const response = await fetch(`${origin}/vendor/serve-sim/helper/${device}/stream.mjpeg`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]), redirect: 'error',
    });
    if ([401, 403].includes(response.status)) throw fail('The local T3 hub requires authorization.', 2);
    await response.body?.getReader().read();
  } catch (error) { if (error.exitCode) throw error; }
  finally { controller.abort(); }
  const state = await controlDuo(origin, device, pose);
  const capture = mkdtempSync(join(tmpdir(), 'duo-pose-capture-'));
  const image = join(capture, 'active.png');
  try {
    execFileSync('xcrun', ['simctl', 'io', device, 'screenshot', `--display=${state.screenId}`, '--type=png', image], {
      timeout: 10_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const png = readFileSync(image);
    validatePng(png, state.screenId);
    if (path) writeFileSync(path, png);
  } catch (error) { throw error.exitCode ? error : fail('The active Duo panel did not produce a screenshot.'); }
  finally { rmSync(capture, { recursive: true, force: true }); }
  console.log(JSON.stringify({ ...state, device, pose }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`duo-pose: ${error.exitCode ? error.message : 'Operation failed.'}`);
    process.exitCode = error.exitCode ?? 4;
  });
}
