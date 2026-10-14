/**
 * TAL-802: copies microphone samples off the audio thread for live dictation, about 85 ms at a time at 48 kHz.
 * Loaded with `audioWorklet.addModule`; the processor's globals are not in the DOM library, so they are declared here.
 */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const FRAMES = 4096

class PcmTap extends AudioWorkletProcessor {
  private buffer = new Float32Array(FRAMES)
  private filled = 0

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (const sample of channel) {
      this.buffer[this.filled++] = sample
      if (this.filled === FRAMES) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(FRAMES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)

export {}
