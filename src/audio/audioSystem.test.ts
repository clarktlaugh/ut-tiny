import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../app/settings';
import type { SimEvent, Vec3, WorldState } from '../sim/types';
import { AudioSystem, type AudioBackend } from './audioSystem';
import { BUSES, BUS_TRIM, busGains, type Bus } from './buses';
import type { SoundCue } from './eventSounds';
import { resumeAudio, resumeOnGesture } from './resume';
import { SOUNDS, SOUND_IDS, announcerSoundId, soundDef, soundUrl, type SoundDef } from './sounds';
import { recipeDuration, renderSynth, SYNTH_PEAK } from './synth';

interface FakeBuffer {
  samples: Float32Array | null;
  seconds: number;
}

class FakeBackend implements AudioBackend<FakeBuffer> {
  sampleRate = 8000;
  state = 'suspended';
  time = 0;
  played: { cue: SoundCue; def: SoundDef; stopped: boolean }[] = [];
  busGain = {} as Record<Bus, number>;
  master = -1;
  disposed = false;

  now(): number {
    return this.time;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  createBuffer(samples: Float32Array): FakeBuffer {
    return { samples, seconds: samples.length / this.sampleRate };
  }
  async decode(data: ArrayBuffer): Promise<FakeBuffer> {
    return { samples: null, seconds: data.byteLength };
  }
  duration(b: FakeBuffer): number {
    return b.seconds;
  }
  play(_b: FakeBuffer, cue: SoundCue, def: SoundDef) {
    const rec = { cue: { ...cue }, def, stopped: false };
    this.played.push(rec);
    return { stop: () => (rec.stopped = true) };
  }
  setBusGain(bus: Bus, gain: number): void {
    this.busGain[bus] = gain;
  }
  setMasterGain(gain: number): void {
    this.master = gain;
  }
  dispose(): void {
    this.disposed = true;
  }
}

const v = (x: number): Vec3 => ({ x, y: 0, z: 0 });
const worldCue = (sound: SoundCue['sound'] = 'explosion'): SoundCue => ({
  sound,
  bus: 'world',
  position: v(1),
  volume: 1,
  rate: 1,
});

function running(maxVoices?: number) {
  const backend = new FakeBackend();
  backend.state = 'running';
  return { backend, audio: new AudioSystem(backend, { maxVoices }) };
}

describe('AudioSystem', () => {
  it('drops cues while the context is suspended, then plays once resumed', async () => {
    const backend = new FakeBackend();
    const audio = new AudioSystem(backend);
    expect(audio.play(worldCue())).toBe(false);
    expect(backend.played).toHaveLength(0);
    await resumeAudio(backend);
    expect(audio.play(worldCue())).toBe(true);
    expect(backend.played).toHaveLength(1);
  });

  it('refuses world cues without a position', () => {
    const { backend, audio } = running();
    expect(audio.play({ sound: 'explosion', bus: 'world', volume: 1, rate: 1 })).toBe(false);
    expect(backend.played).toHaveLength(0);
  });

  it('applies volume settings to master and buses', () => {
    const backend = new FakeBackend();
    const audio = new AudioSystem(backend, { volume: defaultSettings().volume });
    expect(backend.master).toBe(0.8);
    expect(backend.busGain.music).toBeCloseTo(0.5 * BUS_TRIM.music);
    audio.setVolume({ master: 2, sfx: 0.5, music: 0, announcer: Number.NaN });
    expect(backend.master).toBe(1);
    expect(backend.busGain.world).toBeCloseTo(0.5);
    expect(backend.busGain.local).toBeCloseTo(0.5 * BUS_TRIM.local);
    expect(backend.busGain.announcer).toBe(0);
    for (const bus of BUSES) expect(backend.busGain[bus]).toBeDefined();
  });

  it('steals the oldest voice of a sound past its maxVoices', () => {
    const { backend, audio } = running();
    const max = SOUNDS.redeemerBlast.maxVoices;
    for (let i = 0; i <= max; i++) {
      backend.time = i * 0.01;
      audio.play(worldCue('redeemerBlast'));
    }
    expect(backend.played).toHaveLength(max + 1);
    expect(backend.played[0]?.stopped).toBe(true);
    expect(backend.played.slice(1).every((p) => !p.stopped)).toBe(true);
    expect(audio.activeVoices).toBe(max);
  });

  it('caps total voices globally', () => {
    const { backend, audio } = running(3);
    const sounds = ['explosion', 'shockCombo', 'rocketFire', 'sniperFire'] as const;
    sounds.forEach((s, i) => {
      backend.time = i * 0.001;
      audio.play(worldCue(s));
    });
    expect(audio.activeVoices).toBe(3);
    expect(backend.played[0]?.stopped).toBe(true);
  });

  it('frees voices when their sound has finished', () => {
    const { backend, audio } = running();
    audio.play(worldCue('hitConfirm'));
    expect(audio.activeVoices).toBe(1);
    backend.time = recipeDuration(SOUNDS.hitConfirm.synth) + 0.01;
    expect(audio.activeVoices).toBe(0);
  });

  it('places sounds for destroyed entities at their last known position', () => {
    const { backend, audio } = running();
    const state = (entities: WorldState['entities']): WorldState => ({
      tick: 1,
      time: 0,
      rngState: 0,
      entities,
      match: {
        phase: 'playing',
        fragLimit: 0,
        timeLimit: 0,
        elapsed: 0,
        scores: [],
        winner: null,
      },
    });
    const rocket = {
      id: 9,
      kind: 'mine' as const,
      position: v(42),
      owner: 1,
      armed: true,
    };
    audio.handleTick([], state([rocket]), 1);
    const events: SimEvent[] = [
      { type: 'projectileDestroyed', tick: 2, id: 9, byPawn: 2 },
      { type: 'entityDestroyed', tick: 2, id: 9, kind: 'mine' },
    ];
    const cues = audio.handleTick(events, state([]), 1);
    expect(cues).toHaveLength(1);
    expect(backend.played[0]?.cue).toMatchObject({
      sound: 'projectileShotDown',
      position: v(42),
    });
    // Forgotten afterwards.
    audio.handleTick([{ type: 'discDisrupted', tick: 3, disc: 9, byPawn: 2 }], state([]), 1);
    expect(backend.played).toHaveLength(1);
  });

  it('renders each placeholder once and caches it', () => {
    const { backend, audio } = running();
    const spy = vi.spyOn(backend, 'createBuffer');
    audio.play(worldCue());
    audio.play(worldCue());
    expect(spy).toHaveBeenCalledTimes(1);
    audio.preload();
    expect(spy).toHaveBeenCalledTimes(SOUND_IDS.length);
  });

  it('replaces placeholders with listed files and keeps them on failure', async () => {
    const { backend, audio } = running();
    const fetchFn = vi.fn(async (url: string) => ({
      ok: url.endsWith('boom.ogg'),
      arrayBuffer: async () => new ArrayBuffer(3),
    }));
    const loaded = await audio.loadFiles(fetchFn, '/base/', {
      explosion: 'boom.ogg',
      jump: 'missing.ogg',
    });
    expect(loaded).toEqual(['explosion']);
    expect(fetchFn).toHaveBeenCalledWith('/base/sounds/boom.ogg');
    expect(backend.duration(audio.bufferFor('explosion'))).toBe(3);
    expect(audio.bufferFor('jump').samples).not.toBeNull();
  });

  it('stopAll and dispose stop every voice', () => {
    const { backend, audio } = running();
    audio.play(worldCue());
    audio.play({ sound: 'hitConfirm', bus: 'ui', volume: 1, rate: 1 });
    audio.dispose();
    expect(backend.played.every((p) => p.stopped)).toBe(true);
    expect(backend.disposed).toBe(true);
    expect(audio.activeVoices).toBe(0);
  });
});

describe('sound catalog and synth', () => {
  it('renders every sound to non-silent, bounded samples', () => {
    for (const id of SOUND_IDS) {
      const def = soundDef(id);
      expect(def.maxVoices).toBeGreaterThan(0);
      expect(def.refDistance).toBeGreaterThan(1);
      const s = renderSynth(def.synth, 8000, 7);
      expect(s.length).toBe(Math.ceil(recipeDuration(def.synth) * 8000));
      let peak = 0;
      for (const x of s) peak = Math.max(peak, Math.abs(x));
      expect(peak, id).toBeGreaterThan(0.01);
      expect(peak, id).toBeLessThanOrEqual(SYNTH_PEAK + 1e-6);
    }
  });

  it('is deterministic per seed', () => {
    const layers = SOUNDS.explosion.synth;
    expect(renderSynth(layers, 8000, 3)).toEqual(renderSynth(layers, 8000, 3));
    expect(renderSynth(layers, 8000, 3)).not.toEqual(renderSynth(layers, 8000, 4));
  });

  it('has a placeholder for announcer lines', () => {
    const def = soundDef(announcerSoundId('headshot'));
    expect(def.maxVoices).toBe(1);
    expect(renderSynth(def.synth, 8000).length).toBeGreaterThan(0);
  });

  it('builds sound URLs under public/sounds', () => {
    expect(soundUrl('a.ogg')).toBe('/sounds/a.ogg');
    expect(soundUrl('a.ogg', '/ut')).toBe('/ut/sounds/a.ogg');
  });

  it('maps volume settings to bus gains', () => {
    const g = busGains({ master: 1, sfx: 1, music: 1, announcer: 1 });
    expect(g).toEqual(BUS_TRIM);
  });
});

describe('AudioContext resume', () => {
  it('resumes on the first gesture and detaches', async () => {
    const target = new EventTarget();
    const ctx = { state: 'suspended', resume: vi.fn(async () => void (ctx.state = 'running')) };
    const onResumed = vi.fn();
    resumeOnGesture(target, ctx, onResumed);
    expect(ctx.resume).not.toHaveBeenCalled();
    target.dispatchEvent(new Event('keydown'));
    await vi.waitFor(() => expect(onResumed).toHaveBeenCalledTimes(1));
    target.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps listening when resume fails, and can be detached early', async () => {
    const target = new EventTarget();
    const ctx = { state: 'suspended', resume: vi.fn(async () => Promise.reject(new Error('no'))) };
    const detach = resumeOnGesture(target, ctx);
    target.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    target.dispatchEvent(new Event('touchend'));
    await Promise.resolve();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    detach();
    target.dispatchEvent(new Event('keydown'));
    expect(ctx.resume).toHaveBeenCalledTimes(2);
  });

  it('calls back at once when already running, and never resumes a closed context', async () => {
    const onResumed = vi.fn();
    resumeOnGesture(new EventTarget(), { state: 'running', resume: vi.fn() }, onResumed);
    expect(onResumed).toHaveBeenCalledTimes(1);
    const closed = { state: 'closed', resume: vi.fn(async () => {}) };
    expect(await resumeAudio(closed)).toBe(false);
    expect(closed.resume).not.toHaveBeenCalled();
  });
});
