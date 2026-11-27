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
  private stopped = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== 'flush' || this.stopped) return
      this.stopped = true
      if (this.filled > 0) this.send(this.buffer.slice(0, this.filled))
      // The same port orders the acknowledgement behind every PCM block.
      this.port.postMessage('flushed')
    }
  }

  private send(samples: Float32Array<ArrayBuffer>) {
    this.port.postMessage(samples, [samples.buffer])
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (const sample of channel) {
      this.buffer[this.filled++] = sample
      if (this.filled === FRAMES) {
        this.send(this.buffer)
        this.buffer = new Float32Array(FRAMES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)

export {}
