/**
 * TAL-1514: replaces three's meshopt decoder in the build. The original compiles WebAssembly when imported, which the
 * app's CSP forbids, and Talaria never needs it: the server refuses meshopt-compressed models before any byte is sent.
 */
export const MeshoptDecoder = {
  supported: false,
  ready: Promise.resolve(),
  useWorkers(): void { /* never used */ },
  decodeGltfBuffer(): never { throw new Error('meshopt-compressed models are not supported') },
  decodeGltfBufferAsync(): Promise<never> { return Promise.reject(new Error('meshopt-compressed models are not supported')) },
}
