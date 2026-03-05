/**
 * Audio pre-processor.
 *
 * Reduces large audio files before transcription using Web Audio API + lamejs.
 * Avoids ffmpeg.wasm (~30MB) — lamejs is ~150KB, acceptable for Obsidian marketplace.
 *
 * Pipeline (for files > 10MB):
 *   1. AudioContext.decodeAudioData() — decodes m4a/mp3/wav/webm to PCM
 *   2. Mix all channels to mono
 *   3. Downsample to 16kHz
 *   4. Encode to MP3 at 32kbps via lamejs
 *
 * Result: 1-hour meeting ~57MB → ~14MB with no transcription quality loss
 * (Whisper internally works at 16kHz mono regardless of input quality).
 */

import { Mp3Encoder } from 'lamejs'

const SKIP_THRESHOLD_BYTES = 10 * 1024 * 1024  // 10MB
const TARGET_SAMPLE_RATE = 16000
const TARGET_KBPS = 32
const MP3_CHUNK_SIZE = 1152  // lamejs standard block size

export interface PreprocessedAudio {
  buffer: ArrayBuffer
  filename: string       // may have .mp3 extension if compressed
  wasCompressed: boolean
}

export async function preprocessAudio(
  inputBuffer: ArrayBuffer,
  originalFilename: string
): Promise<PreprocessedAudio> {
  if (inputBuffer.byteLength < SKIP_THRESHOLD_BYTES) {
    return { buffer: inputBuffer, filename: originalFilename, wasCompressed: false }
  }

  // Decode via Web Audio API (available in Electron/Obsidian)
  const audioContext = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await audioContext.decodeAudioData(inputBuffer.slice(0))
  } finally {
    await audioContext.close()
  }

  const mono = mixToMono(decoded)
  const samples16k = downsample(mono, decoded.sampleRate, TARGET_SAMPLE_RATE)
  const mp3Buffer = encodeMp3(samples16k, TARGET_SAMPLE_RATE, TARGET_KBPS)

  const baseName = originalFilename.replace(/\.[^.]+$/, '')

  return {
    buffer: mp3Buffer,
    filename: `${baseName}.mp3`,
    wasCompressed: true,
  }
}

function mixToMono(decoded: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = decoded
  const mono = new Float32Array(length)
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channelData = decoded.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / numberOfChannels
    }
  }
  return mono
}

function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const outputLength = Math.floor(samples.length / ratio)
  const output = new Float32Array(outputLength)
  for (let i = 0; i < outputLength; i++) {
    output[i] = samples[Math.floor(i * ratio)]
  }
  return output
}

function encodeMp3(samples: Float32Array, sampleRate: number, kbps: number): ArrayBuffer {
  // Convert Float32 to Int16 (lamejs expects Int16Array)
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.floor(samples[i] * 32768)))
  }

  const encoder = new Mp3Encoder(1, sampleRate, kbps)
  const mp3Data: Uint8Array[] = []

  for (let i = 0; i < pcm.length; i += MP3_CHUNK_SIZE) {
    const chunk = pcm.subarray(i, i + MP3_CHUNK_SIZE)
    const encoded = encoder.encodeBuffer(chunk)
    if (encoded.length > 0) mp3Data.push(new Uint8Array(encoded))
  }

  const flushed = encoder.flush()
  if (flushed.length > 0) mp3Data.push(new Uint8Array(flushed))

  // Concatenate all chunks into a single ArrayBuffer
  const totalLength = mp3Data.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of mp3Data) {
    output.set(chunk, offset)
    offset += chunk.length
  }

  return output.buffer
}
