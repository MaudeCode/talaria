import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlDuo, hubUrl, selectDevice, validatePng } from './duo-pose.mjs';

const device = '00000000-0000-4000-8000-000000000001';
const open = { screenId: 3, width: 2007, height: 2853, orientation: 'portrait', supportsHingeAngle: true, hingeAngle: 180, hingePose: 'open' };
const closed = { ...open, screenId: 1, width: 1398, height: 2034, hingeAngle: 0, hingePose: 'closed' };

async function scenario(run, initial = open, admit = true) {
  const original = globalThis.WebSocket;
  let socket;
  class FakeSocket {
    listeners = new Map();
    sent = [];
    constructor(url) {
      this.url = url;
      socket = this;
      queueMicrotask(() => { this.emit(0x82, initial); if (admit) this.emit(0x83); });
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    emit(tag, payload) {
      const packet = Buffer.concat([Buffer.from([tag]), Buffer.from(payload === undefined ? '' : JSON.stringify(payload))]);
      this.listeners.get('message')?.({ data: packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.length) });
    }
    send(packet) { this.sent.push({ tag: packet[0], payload: JSON.parse(Buffer.from(packet).subarray(1)) }); }
    close() {}
  }
  globalThis.WebSocket = FakeSocket;
  try { await run(() => socket); }
  finally { globalThis.WebSocket = original; }
}

test('acknowledgement before panel handoff waits for the settled cover', async () => {
  await scenario(async socket => {
    const result = controlDuo('http://127.0.0.1:1', device, 'closed');
    await tick();
    assert.equal(new URL(socket().url).searchParams.get('device'), device);
    assert.deepEqual(socket().sent, [{ tag: 0x10, payload: { requestId: 1, command: { control: 'pose', value: 'closed' } } }]);
    socket().emit(0x82, { ...open, hingeAngle: 0 });
    socket().emit(0x90, { requestId: 1, ok: true });
    queueMicrotask(() => socket().emit(0x82, closed));
    assert.equal((await result).screenId, 1, 'success must wait for the native panel handoff');
  });
});

test('settled state before acknowledgement still needs the matching positive reply', async () => {
  await scenario(async socket => {
    let finished = false;
    const result = controlDuo('http://127.0.0.1:1', device, 'closed').then(state => { finished = true; return state; });
    await tick();
    socket().emit(0x82, closed);
    socket().emit(0x90, { requestId: 99, ok: true });
    await tick();
    assert.equal(finished, false);
    socket().emit(0x90, { requestId: 1, ok: true });
    assert.equal((await result).hingeAngle, 0);
  });
});

test('already-settled targets are no-ops', async () => {
  for (const [pose, state] of [['open', open], ['closed', closed], ['book', { ...open, hingeAngle: 90, hingePose: 'book' }],
    ['rotate-right', { ...open, orientation: 'landscape_right' }]]) {
    await scenario(async socket => {
      assert.equal((await controlDuo('http://127.0.0.1:1', device, pose)).changed, false);
      assert.deepEqual(socket().sent, []);
    }, state);
  }
});

test('rotate-right uses orientation framing and fresh state rather than a pose acknowledgement', async () => {
  await scenario(async socket => {
    const result = controlDuo('http://127.0.0.1:1', device, 'rotate-right', 1000);
    await tick();
    assert.deepEqual(socket().sent, [{ tag: 7, payload: { orientation: 'landscape_right' } }]);
    socket().emit(0x82, { ...open, orientation: 'landscape_right' });
    assert.equal((await result).orientation, 'landscape_right');
  });
});

test('native sensor orientation confirms rotation even when the app locks its framebuffer', async () => {
  await scenario(async socket => {
    let completed = false;
    const result = controlDuo('http://127.0.0.1:1', device, 'rotate-right').then(state => { completed = true; return state; });
    await tick();
    socket().emit(0x82, { ...open, physicalOrientation: 'landscape-right' });
    await tick();
    try { assert.equal(completed, true, 'native orientation must confirm rotation independently of app layout'); }
    finally { socket().emit(0x82, { ...open, orientation: 'landscape_right', physicalOrientation: 'landscape-right' }); await result; }
  }, { ...open, physicalOrientation: 'portrait' });
});

test('refused, malformed, unsupported and disconnected input fail closed', async () => {
  for (const reply of [s => s.emit(0x90, { requestId: 1, ok: false }),
    s => s.emit(0x90, { requestId: 1, ok: 'yes' }),
    s => s.emit(0x82, { ...open, hingeAngle: -1 }),
    s => s.emit(0x82, { ...open, supportsHingeAngle: false }),
    s => s.emit(0x82, { ...open, inputUnavailable: true }),
    s => s.listeners.get('close')()]) {
    await scenario(async socket => {
      const result = controlDuo('http://127.0.0.1:1', device, 'closed', 1000);
      const failure = assert.rejects(result);
      await tick();
      reply(socket());
      await failure;
    });
  }
});

test('a positive reply without native handoff reaches the bounded deadline', async () => {
  await scenario(async socket => {
    const result = controlDuo('http://127.0.0.1:1', device, 'closed', 25);
    const failure = assert.rejects(result, /deadline/);
    await tick();
    socket().emit(0x90, { requestId: 1, ok: true });
    await failure;
  });
});

test('unknown fields and packet types do not prevent normal handoff', async () => {
  await scenario(async socket => {
    const result = controlDuo('http://127.0.0.1:1', device, 'closed');
    await tick();
    socket().emit(0x91, { future: true });
    socket().emit(0x82, { ...closed, future: 'allowed' });
    socket().emit(0x90, { requestId: 1, ok: true });
    assert.equal((await result).screenId, 1);
  });
});

test('a fresh helper with no initial angle can receive an absolute target', async () => {
  await scenario(async socket => {
    const result = controlDuo('http://127.0.0.1:1', device, 'closed');
    await tick();
    assert.equal(socket().sent.length, 1);
    socket().emit(0x90, { requestId: 1, ok: true });
    socket().emit(0x82, closed);
    assert.equal((await result).screenId, 1);
  }, { ...open, hingeAngle: undefined });
});

test('the same angle in a different native pose is not a book no-op', async () => {
  await scenario(async socket => {
    const result = controlDuo('http://127.0.0.1:1', device, 'book');
    await tick();
    assert.equal(socket().sent.length, 1);
    socket().emit(0x90, { requestId: 1, ok: true });
    socket().emit(0x82, { ...open, hingeAngle: 90, hingePose: 'book' });
    assert.equal((await result).hingePose, 'book');
  }, { ...open, hingeAngle: 90, hingePose: 'tent' });
});

test('input admission is required before sending or declaring a no-op', async () => {
  await scenario(async socket => {
    const result = controlDuo('http://127.0.0.1:1', device, 'open', 25);
    const failure = assert.rejects(result, /deadline/);
    await tick();
    assert.equal(socket().sent.length, 0);
    await failure;
  }, open, false);
});

test('device selection rejects ambiguous, shutdown and non-Duo simulators', () => {
  const duo = { udid: device, state: 'Booted', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo' };
  assert.equal(selectDevice({ synthetic: [duo] }, 'booted'), device);
  assert.equal(selectDevice({ synthetic: [duo] }, device.toUpperCase()), device);
  assert.throws(() => selectDevice({ synthetic: [duo, { ...duo, udid: 'other' }] }, 'booted'), /exactly one/);
  for (const wrong of [{ ...duo, state: 'Shutdown' }, { ...duo, deviceTypeIdentifier: 'ordinary-phone' }])
    assert.throws(() => selectDevice({ synthetic: [wrong] }, 'booted'), /exactly one/);
});

test('hub override stays on a plain loopback origin', () => {
  assert.equal(hubUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  for (const url of ['https://example.test', 'http://user:secret@localhost', 'http://localhost/path',
    'http://localhost?token=secret', 'not a URL']) assert.throws(() => hubUrl(url));
});

test('PNG checks require the active panel dimensions in either orientation', () => {
  function png(width, height) {
    const image = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
    image.write('IHDR', 12); image.writeUInt32BE(width, 16); image.writeUInt32BE(height, 20);
    return image;
  }
  validatePng(png(2853, 2007), 3);
  validatePng(png(1398, 2034), 1);
  assert.throws(() => validatePng(png(1398, 2034), 3), /dimensions/);
  assert.throws(() => validatePng(Buffer.from('invalid'), 1), /PNG/);
});

test('live leased Duo round trip and repeated targets', { skip: !process.env.DUO_POSE_LIVE_DEVICE }, () => {
  const udid = process.env.DUO_POSE_LIVE_DEVICE;
  const root = mkdtempSync(join(tmpdir(), 'duo-pose-'));
  const command = fileURLToPath(new URL('./duo-pose', import.meta.url));
  try {
    for (const pose of ['closed', 'open', 'closed', 'book', 'rotate-right']) {
      const screenshot = join(root, `${pose}.png`);
      const invoke = () => JSON.parse(execFileSync(command, [udid, pose, '--screenshot', screenshot], { timeout: 30_000, encoding: 'utf8' }));
      const first = invoke();
      assert.equal(first.device, udid);
      assert.equal(first.pose, pose);
      assert.equal(first.screenId, pose === 'closed' ? 1 : 3);
      if (pose !== 'rotate-right') assert.equal(first.hingeAngle, { closed: 0, open: 180, book: 90 }[pose]);
      else assert.equal(first.physicalOrientation ?? first.orientation.replaceAll('_', '-'), 'landscape-right');
      validatePng(readFileSync(screenshot), first.screenId);
      assert.equal(invoke().changed, false, `${pose} must be a no-op when repeated`);
      console.log(`verified ${pose}: display ${first.screenId}, ${first.width}x${first.height}; repeated request was a no-op`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
