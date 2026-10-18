/**
 * Audio system (docs/DESIGN.md §8.4).
 *
 * Consumes each tick's `SimEvent`s, turns them into cues (`eventSounds.ts`)
 * and plays them through an `AudioBackend`. The backend owns the actual Web
 * Audio graph (`ThreeAudioBackend` in the browser); this class owns the parts
 * worth testing without a browser: buffer caching, per-sound and global voice
 * limits, bus volumes, last-known entity positions, and dropping sounds while
 * the context is still suspended (they would otherwise all fire at once on
 * the first click).
 */
import type { VolumeSettings } from '../app/settings';
import type { EntityId, PawnId, SimEvent, Vec3, WorldState } from '../sim/types';
import { BUSES, busGains, clamp01, type Bus } from './buses';
import { cuesForEvents, type SoundCue } from './eventSounds';
import { SOUND_FILES, SOUND_IDS, soundDef, soundUrl, type SoundDef, type SoundId } from './sounds';
import { renderSynth } from './synth';

export interface VoiceHandle {
  stop(): void;
}

/** The Web Audio side, implemented by `ThreeAudioBackend` (and fakes in tests). */
export interface AudioBackend<TBuffer = unknown> {
  readonly sampleRate: number;
  /** `AudioContext.state`: 'suspended' | 'running' | 'closed' (or 'interrupted' on Safari). */
  readonly state: string;
  /** Monotonic seconds (`AudioContext.currentTime`). */
  now(): number;
  resume(): Promise<void>;
  createBuffer(samples: Float32Array): TBuffer;
  decode(data: ArrayBuffer): Promise<TBuffer>;
  duration(buffer: TBuffer): number;
  /** Start one voice; null when the backend has no free source. */
  play(buffer: TBuffer, cue: Readonly<SoundCue>, def: Readonly<SoundDef>): VoiceHandle | null;
  setBusGain(bus: Bus, gain: number): void;
  setMasterGain(gain: number): void;
  dispose(): void;
}

export interface AudioSystemOptions {
  volume?: Readonly<VolumeSettings>;
  /** Global cap on simultaneous voices. Default 32. */
  maxVoices?: number;
}

interface ActiveVoice {
  sound: SoundId;
  bus: Bus;
  startedAt: number;
  endsAt: number;
  handle: VoiceHandle;
}

export const DEFAULT_MAX_VOICES = 32;

export class AudioSystem<TBuffer = unknown> {
  readonly backend: AudioBackend<TBuffer>;
  readonly maxVoices: number;

  private readonly buffers = new Map<SoundId, TBuffer>();
  private readonly voices: ActiveVoice[] = [];
  private readonly positions = new Map<EntityId, Vec3>();

  constructor(backend: AudioBackend<TBuffer>, options: AudioSystemOptions = {}) {
    this.backend = backend;
    this.maxVoices = Math.max(1, Math.floor(options.maxVoices ?? DEFAULT_MAX_VOICES));
    this.setVolume(options.volume ?? { master: 0.8, sfx: 1, music: 0.5, announcer: 1 });
  }

  /** True once the context runs; until then cues are dropped. */
  get running(): boolean {
    return this.backend.state === 'running';
  }

  /** Number of voices that have not yet finished. */
  get activeVoices(): number {
    this.prune();
    return this.voices.length;
  }

  setVolume(volume: Readonly<VolumeSettings>): void {
    this.backend.setMasterGain(clamp01(volume.master));
    const gains = busGains(volume);
    for (const bus of BUSES) this.backend.setBusGain(bus, gains[bus]);
  }

  /**
   * Feed one tick: its events, the resulting state and the local pawn.
   * Returns the cues that were mapped (played or not), for debugging.
   */
  handleTick(
    events: readonly SimEvent[],
    state: Readonly<WorldState> | null,
    localPawn: PawnId,
  ): SoundCue[] {
    if (state) {
      for (const ent of state.entities) {
        const p = this.positions.get(ent.id);
        if (p) {
          p.x = ent.position.x;
          p.y = ent.position.y;
          p.z = ent.position.z;
        } else {
          this.positions.set(ent.id, { ...ent.position });
        }
      }
    }
    const cues = cuesForEvents(events, {
      localPawn,
      positionOf: (id) => this.positions.get(id),
    });
    for (const c of cues) this.play(c);
    // Forget destroyed entities only after their last sounds were placed.
    for (const e of events) if (e.type === 'entityDestroyed') this.positions.delete(e.id);
    return cues;
  }

  /** Play one cue now. Returns false when it was dropped. */
  play(cue: Readonly<SoundCue>): boolean {
    if (!this.running) return false;
    if (cue.bus === 'world' && !cue.position) return false;
    const def = soundDef(cue.sound);
    const now = this.backend.now();
    this.prune(now);

    let same = 0;
    for (const v of this.voices) if (v.sound === cue.sound) same++;
    if (same >= def.maxVoices) this.steal((v) => v.sound === cue.sound);
    if (this.voices.length >= this.maxVoices) this.steal(() => true);

    const buffer = this.bufferFor(cue.sound);
    const handle = this.backend.play(buffer, cue, def);
    if (!handle) return false;
    const rate = cue.rate > 0 ? cue.rate : 1;
    this.voices.push({
      sound: cue.sound,
      bus: cue.bus,
      startedAt: now,
      endsAt: now + this.backend.duration(buffer) / rate,
      handle,
    });
    return true;
  }

  /** Stop everything (match end, map change). */
  stopAll(): void {
    for (const v of this.voices) v.handle.stop();
    this.voices.length = 0;
  }

  /** Render every placeholder now instead of on first use (avoids a hitch on the first shot). */
  preload(): void {
    for (const id of SOUND_IDS) this.bufferFor(id);
  }

  /**
   * Fetch and decode the recorded files listed in `SOUND_FILES`, replacing the
   * placeholders. Failures keep the placeholder. Resolves to the ids loaded.
   */
  async loadFiles(
    fetchFn: (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>,
    base = '/',
    files: Partial<Record<SoundId, string>> = SOUND_FILES,
  ): Promise<SoundId[]> {
    const loaded: SoundId[] = [];
    await Promise.all(
      (Object.entries(files) as [SoundId, string][]).map(async ([id, file]) => {
        try {
          const res = await fetchFn(soundUrl(file, base));
          if (!res.ok) return;
          this.buffers.set(id, await this.backend.decode(await res.arrayBuffer()));
          loaded.push(id);
        } catch {
          // Keep the placeholder.
        }
      }),
    );
    return loaded;
  }

  dispose(): void {
    this.stopAll();
    this.buffers.clear();
    this.positions.clear();
    this.backend.dispose();
  }

  /** Cached buffer for a sound, rendering its placeholder on first use. */
  bufferFor(id: SoundId): TBuffer {
    let buf = this.buffers.get(id);
    if (buf === undefined) {
      buf = this.backend.createBuffer(
        renderSynth(soundDef(id).synth, this.backend.sampleRate, seedFor(id)),
      );
      this.buffers.set(id, buf);
    }
    return buf;
  }

  private prune(now = this.backend.now()): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i]!.endsAt <= now) this.voices.splice(i, 1);
    }
  }

  /** Stop the oldest voice matching `pred`. */
  private steal(pred: (v: ActiveVoice) => boolean): void {
    let oldest = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i]!;
      if (pred(v) && (oldest < 0 || v.startedAt < this.voices[oldest]!.startedAt)) oldest = i;
    }
    if (oldest >= 0) {
      this.voices[oldest]!.handle.stop();
      this.voices.splice(oldest, 1);
    }
  }
}

function seedFor(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}
