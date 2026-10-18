/**
 * Web Audio backend on Three.js audio objects (docs/DESIGN.md §2, §8.4, §12).
 *
 * - One `AudioListener` (add it to the render camera; its gain is the master).
 * - One `GainNode` per bus, feeding the listener.
 * - A pool of `PositionalAudio` sources for the `world` bus, children of
 *   `root` (add `root` to the scene), and a pool of plain `Audio` sources for
 *   the non-positional buses. Pools are allocated up front; when one is
 *   exhausted the oldest voice in it is reused (§12: no per-frame allocation).
 */
import { Audio, AudioListener, Object3D, PositionalAudio } from 'three';
import type { AudioBackend, VoiceHandle } from './audioSystem';
import { BUSES, type Bus } from './buses';
import type { SoundCue } from './eventSounds';
import { DISTANCE_MODEL, type SoundDef } from './sounds';

export interface ThreeAudioBackendOptions {
  /** Defaults to a new listener (which creates the shared AudioContext). */
  listener?: AudioListener;
  /** Positional sources. Default 24. */
  worldVoices?: number;
  /** Non-positional sources shared by local, ui, announcer and music. Default 12. */
  flatVoices?: number;
}

interface Slot<T extends Audio<GainNode | PannerNode>> {
  audio: T;
  bus: Bus | null;
  startedAt: number;
  /** Bumped on every play so a stale handle cannot stop a reused source. */
  generation: number;
}

export class ThreeAudioBackend implements AudioBackend<AudioBuffer> {
  readonly listener: AudioListener;
  /** Parent of the positional sources; add it to the scene at the origin. */
  readonly root = new Object3D();

  private readonly context: AudioContext;
  private readonly busNodes: Record<Bus, GainNode>;
  private readonly worldPool: Slot<PositionalAudio>[] = [];
  private readonly flatPool: Slot<Audio>[] = [];

  constructor(options: ThreeAudioBackendOptions = {}) {
    this.listener = options.listener ?? new AudioListener();
    this.context = this.listener.context;
    this.root.name = 'audio';

    const nodes = {} as Record<Bus, GainNode>;
    for (const bus of BUSES) {
      const g = this.context.createGain();
      g.connect(this.listener.getInput());
      nodes[bus] = g;
    }
    this.busNodes = nodes;

    for (let i = 0; i < (options.worldVoices ?? 24); i++) {
      const audio = new PositionalAudio(this.listener);
      audio.setDistanceModel(DISTANCE_MODEL.model);
      audio.setRolloffFactor(DISTANCE_MODEL.rolloffFactor);
      audio.setMaxDistance(DISTANCE_MODEL.maxDistance);
      const slot: Slot<PositionalAudio> = { audio, bus: null, startedAt: -1, generation: 0 };
      this.route(slot, 'world');
      this.root.add(audio);
      this.worldPool.push(slot);
    }
    for (let i = 0; i < (options.flatVoices ?? 12); i++) {
      this.flatPool.push({
        audio: new Audio(this.listener),
        bus: null,
        startedAt: -1,
        generation: 0,
      });
    }
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  get state(): string {
    return this.context.state;
  }

  now(): number {
    return this.context.currentTime;
  }

  resume(): Promise<void> {
    return this.context.resume();
  }

  createBuffer(samples: Float32Array): AudioBuffer {
    const buf = this.context.createBuffer(1, Math.max(1, samples.length), this.context.sampleRate);
    buf.getChannelData(0).set(samples);
    return buf;
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.context.decodeAudioData(data);
  }

  duration(buffer: AudioBuffer): number {
    return buffer.duration;
  }

  play(buffer: AudioBuffer, cue: Readonly<SoundCue>, def: Readonly<SoundDef>): VoiceHandle | null {
    const positional = cue.bus === 'world';
    const slot = positional ? pick(this.worldPool) : pick(this.flatPool);
    if (!slot) return null;
    const { audio } = slot;
    if (audio.isPlaying) audio.stop();
    this.route(slot, cue.bus);

    if (positional && cue.position) {
      const pa = audio as PositionalAudio;
      pa.setRefDistance(def.refDistance);
      pa.position.set(cue.position.x, cue.position.y, cue.position.z);
      pa.updateMatrixWorld(true);
      snapPanner(pa.panner, this.context.currentTime, pa);
    }
    audio.setBuffer(buffer);
    audio.setVolume(def.volume * cue.volume);
    audio.setPlaybackRate(cue.rate > 0 ? cue.rate : 1);
    audio.play();

    slot.startedAt = this.context.currentTime;
    const generation = ++slot.generation;
    return {
      stop: () => {
        if (slot.generation === generation && audio.isPlaying) audio.stop();
      },
    };
  }

  setBusGain(bus: Bus, gain: number): void {
    this.busNodes[bus].gain.setTargetAtTime(gain, this.context.currentTime, 0.01);
  }

  setMasterGain(gain: number): void {
    this.listener.setMasterVolume(gain);
  }

  dispose(): void {
    for (const slot of [...this.worldPool, ...this.flatPool]) {
      if (slot.audio.isPlaying) slot.audio.stop();
      slot.audio.gain.disconnect();
    }
    for (const bus of BUSES) this.busNodes[bus].disconnect();
    this.root.removeFromParent();
    this.root.clear();
  }

  /** Point a source's output at a bus (sources default to the listener input). */
  private route(slot: Slot<Audio<GainNode | PannerNode>>, bus: Bus): void {
    if (slot.bus === bus) return;
    slot.audio.gain.disconnect();
    slot.audio.gain.connect(this.busNodes[bus]);
    slot.bus = bus;
  }
}

/** First idle source, else the one started longest ago. */
function pick<T extends Audio<GainNode | PannerNode>>(pool: Slot<T>[]): Slot<T> | undefined {
  let oldest: Slot<T> | undefined;
  for (const slot of pool) {
    if (!slot.audio.isPlaying) return slot;
    if (!oldest || slot.startedAt < oldest.startedAt) oldest = slot;
  }
  return oldest;
}

/**
 * `PositionalAudio.updateMatrixWorld` ramps the panner from its previous
 * position over a frame. A pooled source jumps across the map between uses,
 * so set the new position immediately instead of sweeping it.
 */
function snapPanner(panner: PannerNode, t: number, obj: Object3D): void {
  if (!panner.positionX) return;
  const e = obj.matrixWorld.elements;
  const x = e[12] ?? 0;
  const y = e[13] ?? 0;
  const z = e[14] ?? 0;
  for (const [param, v] of [
    [panner.positionX, x],
    [panner.positionY, y],
    [panner.positionZ, z],
  ] as const) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}
