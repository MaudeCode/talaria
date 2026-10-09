declare module 'seek-bzip' {
  interface OutputStream { writeByte(byte: number): void }
  const Bunzip: { decode(input: Uint8Array, output: OutputStream, multistream?: boolean): void }
  export = Bunzip
}
