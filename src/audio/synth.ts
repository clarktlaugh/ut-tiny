/**
 * Placeholder sound synthesis (docs/DESIGN.md §8.4).
 *
 * Every sound in the catalog has a small recipe of oscillator and noise layers
 * that is rendered to raw samples here, so the game makes sensible noises
 * before any recorded assets exist. Pure and DOM-free: the output is a
 * `Float32Array` that the backend copies into an `AudioBuffer`.
 */

export type Waveform = 'sine' | 'square' | 'saw' | 'triangle' | 'noise';

/** One layer of a placeholder sound. Times are seconds, frequencies Hz. */
export interface SynthLayer {
  wave: Waveform;
  /** Start frequency. For noise, the cutoff of the one-pole low-pass (0 = unfiltered). */
  freq: number;
  /** Frequency at the end of the layer (linear sweep). Defaults to `freq`. */
  freqEnd?: number;
  /** Offset from the start of the sound. Default 0. */
  start?: number;
  duration: number;
  /** Linear fade-in time. Default 2 ms, which avoids clicks. */
  attack?: number;
  /** Peak gain of the layer. Default 1. */
  gain?: number;
}

/** Peak level a rendered sound is normalised to when its layers sum above it. */
export const SYNTH_PEAK = 0.9;

/** Total length of a recipe in seconds. */
export function recipeDuration(layers: readonly SynthLayer[]): number {
  let end = 0;
  for (const l of layers) end = Math.max(end, (l.start ?? 0) + l.duration);
  return end;
}

/**
 * Render a recipe to mono samples. Deterministic for a given `seed`, so tests
 * and repeated loads produce identical buffers.
 */
export function renderSynth(
  layers: readonly SynthLayer[],
  sampleRate: number,
  seed = 1,
): Float32Array {
  const length = Math.max(1, Math.ceil(recipeDuration(layers) * sampleRate));
  const out = new Float32Array(length);
  let state = seed >>> 0;
  const noise = (): number => {
    // mulberry32, as in src/sim/rng.ts; inlined so audio has no sim dependency.
    let t = (state = (state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };

  for (const layer of layers) {
    const start = Math.floor((layer.start ?? 0) * sampleRate);
    const count = Math.floor(layer.duration * sampleRate);
    const attack = Math.max(1, Math.floor((layer.attack ?? 0.002) * sampleRate));
    const gain = layer.gain ?? 1;
    const f0 = layer.freq;
    const f1 = layer.freqEnd ?? layer.freq;
    let phase = 0;
    let lp = 0;
    for (let i = 0; i < count; i++) {
      const idx = start + i;
      if (idx >= length) break;
      const u = i / count;
      const freq = f0 + (f1 - f0) * u;
      let s: number;
      if (layer.wave === 'noise') {
        const n = noise();
        if (freq > 0) {
          const a = 1 - Math.exp((-2 * Math.PI * freq) / sampleRate);
          lp += a * (n - lp);
          // A one-pole low-pass loses level as the cutoff drops; compensate a little.
          s = lp * Math.min(4, Math.sqrt(sampleRate / (4 * freq)));
        } else {
          s = n;
        }
      } else {
        phase += freq / sampleRate;
        phase -= Math.floor(phase);
        s = oscillator(layer.wave, phase);
      }
      const env = (i < attack ? i / attack : 1) * (1 - u) * (1 - u);
      out[idx]! += s * env * gain;
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]!));
  if (peak > SYNTH_PEAK) {
    const k = SYNTH_PEAK / peak;
    for (let i = 0; i < length; i++) out[i]! *= k;
  }
  return out;
}

function oscillator(wave: Exclude<Waveform, 'noise'>, phase: number): number {
  switch (wave) {
    case 'sine':
      return Math.sin(phase * 2 * Math.PI);
    case 'square':
      return phase < 0.5 ? 1 : -1;
    case 'saw':
      return phase * 2 - 1;
    case 'triangle':
      return phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
  }
}
