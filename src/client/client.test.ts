import type { Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioBackend, VoiceHandle } from '../audio';
import type { SoundCue } from '../audio/eventSounds';
import { MemoryStorage, SettingsStore } from '../app/settings';
import type { FrameScheduler } from '../session/gameLoop';
import { NO_ENTITY, type SimEvent, type WorldState } from '../sim/types';
import { createClient, type ClientFrame, type ClientRenderer, type ClientWindow } from './client';
import { fxPlugin, hudPlugin, type FxLike } from './plugins';
import { findPawn } from './viewTarget';
import { eyePosition } from '../sim/weapons/core/geometry';

class FakeRenderer implements ClientRenderer {
  autoClear = true;
  pixelRatio = 0;
  size: [number, number] = [0, 0];
  renders = 0;
  depthClears = 0;
  disposed = false;
  setPixelRatio(r: number): void {
    this.pixelRatio = r;
  }
  setSize(w: number, h: number): void {
    this.size = [w, h];
  }
  clearDepth(): void {
    this.depthClears++;
  }
  render(): void {
    this.renders++;
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeAudio implements AudioBackend<number> {
  sampleRate = 8000;
  state = 'suspended';
  cues: SoundCue[] = [];
  disposed = false;
  now(): number {
    return 0;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  createBuffer(samples: Float32Array): number {
    return samples.length;
  }
  async decode(data: ArrayBuffer): Promise<number> {
    return data.byteLength;
  }
  duration(b: number): number {
    return b / this.sampleRate;
  }
  play(_b: number, cue: SoundCue): VoiceHandle {
    this.cues.push(cue);
    return { stop() {} };
  }
  setBusGain(): void {}
  setMasterGain(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

class FakeWindow extends EventTarget {
  innerWidth = 800;
  innerHeight = 400;
  devicePixelRatio = 3;
}

/** Never schedules; tests drive frames with `session.advance`. */
const MANUAL: FrameScheduler = { request: () => 0, cancel: () => {} };

async function setup() {
  const renderer = new FakeRenderer();
  const audio = new FakeAudio();
  const win = new FakeWindow();
  const client = await createClient({
    canvas: {} as HTMLCanvasElement,
    seed: 3,
    touch: false,
    renderer,
    audio,
    window: win as unknown as ClientWindow,
    settings: new SettingsStore(new MemoryStorage()),
    scheduler: MANUAL,
    pauseOnBlur: false,
  });
  return { client, renderer, audio, win };
}

function run(client: Awaited<ReturnType<typeof setup>>['client'], frames: number): SimEvent[] {
  const events: SimEvent[] = [];
  const off = client.session.onTick((ev) => events.push(...ev));
  for (let i = 0; i < frames; i++) client.session.advance(1 / 60);
  off();
  return events;
}

describe('client shell', () => {
  it('spawns the local player in the laundry room, walks, jumps and fires the assault rifle', async () => {
    const { client, renderer, audio } = await setup();
    try {
      expect(client.world.options.map.name).toBe('laundry-room');
      expect(client.localPawn).not.toBe(NO_ENTITY);

      const spawn = run(client, 150);
      expect(spawn.some((e) => e.type === 'respawn' && e.pawn === client.localPawn)).toBe(true);
      const start = findPawn(client.world.getState(), client.localPawn)!;
      expect(start.alive).toBe(true);
      expect(start.weapon).toBe('assault');

      // Walk forward for a second.
      client.player.input.press('KeyW', 0);
      run(client, 60);
      client.player.input.release('KeyW');
      const walked = findPawn(client.world.getState(), client.localPawn)!;
      const moved = Math.hypot(
        walked.position.x - start.position.x,
        walked.position.z - start.position.z,
      );
      expect(moved).toBeGreaterThan(2);

      // Jump.
      run(client, 30);
      client.player.input.press('Space', 2000);
      const jump = run(client, 10);
      client.player.input.release('Space');
      expect(jump.some((e) => e.type === 'jump' && e.pawn === client.localPawn)).toBe(true);
      run(client, 90);

      // Fire the assault rifle (spawn protection ends on firing). Audio plays once resumed.
      await audio.resume();
      client.player.input.press('Mouse0', 4000);
      const fire = run(client, 30);
      client.player.input.release('Mouse0');
      const shots = fire.filter(
        (e) => e.type === 'shotFired' && e.pawn === client.localPawn && e.weapon === 'assault',
      );
      expect(shots.length).toBeGreaterThan(0);

      // Audio heard the shots; the world and the view model pass were drawn.
      expect(audio.cues.some((c) => c.sound.startsWith('assault'))).toBe(true);
      expect(renderer.renders).toBeGreaterThan(300);
      expect(renderer.depthClears).toBeGreaterThan(0);
      expect(renderer.autoClear).toBe(true);

      // The camera sits at the pawn's eyes and our own body is hidden.
      const pawn = findPawn(client.world.getState(), client.localPawn)!;
      const eye = eyePosition(pawn);
      expect(client.camera.position.distanceTo(eye as never)).toBeLessThan(0.5);
      expect(client.target?.kind).toBe('pawn');
      expect(client.view.objectFor(client.localPawn)?.visible).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it('sizes the renderer and camera and follows window resizes', async () => {
    const { client, renderer, win } = await setup();
    try {
      expect(renderer.size).toEqual([800, 400]);
      expect(renderer.pixelRatio).toBe(2); // dpr 3 capped at 2, render scale 1
      expect(client.camera.aspect).toBeCloseTo(2);
      win.innerWidth = 400;
      win.innerHeight = 800;
      win.dispatchEvent(new Event('resize'));
      expect(renderer.size).toEqual([400, 800]);
      expect(client.camera.aspect).toBeCloseTo(0.5);
      expect(client.camera.fov).toBeLessThanOrEqual(110);
      client.settings.update({ renderScale: 0.5 });
      expect(renderer.pixelRatio).toBe(1);
    } finally {
      client.dispose();
    }
  });

  it('mounts plugins for ticks, frames, resize and dispose', async () => {
    const { client, renderer, audio } = await setup();
    const log = { ticks: 0, frames: 0, after: 0, resized: [] as number[][], disposed: 0 };
    let lastFrame: ClientFrame | null = null;
    const off = client.use({
      tick: () => log.ticks++,
      frame: (f) => {
        log.frames++;
        lastFrame = f;
      },
      afterRender: () => log.after++,
      resize: (w, h) => log.resized.push([w, h]),
      dispose: () => log.disposed++,
    });
    expect(log.resized).toEqual([[800, 400]]);
    run(client, 5);
    expect(log.ticks).toBe(5);
    expect(log.frames).toBe(5);
    expect(log.after).toBe(5);
    expect(lastFrame!.camera).toBe(client.camera);
    expect(lastFrame!.localPawn).toBe(client.localPawn);
    off();
    expect(log.disposed).toBe(1);
    run(client, 2);
    expect(log.ticks).toBe(5);

    client.use({ dispose: () => log.disposed++ });
    client.dispose();
    expect(log.disposed).toBe(2);
    expect(renderer.disposed).toBe(false); // the caller owns an injected renderer
    expect(audio.disposed).toBe(true);
  });

  it('drives FX and HUD adapters', async () => {
    const { client } = await setup();
    const calls: string[] = [];
    const fx: FxLike = {
      root: { name: 'fx' } as Object3D,
      handleEvents: () => calls.push('fx.events'),
      update: () => calls.push('fx.update'),
      dispose: () => calls.push('fx.dispose'),
    };
    const added: Object3D[] = [];
    const scene = {
      add: (o: Object3D) => added.push(o),
      remove: (o: Object3D) => added.splice(added.indexOf(o), 1),
    } as unknown as Object3D;
    const offFx = client.use(fxPlugin(scene, fx));
    const states: Readonly<WorldState>[] = [];
    const offHud = client.use(
      hudPlugin({
        handleEvents: () => calls.push('hud.events'),
        update: (s) => {
          states.push(s);
          calls.push('hud.update');
        },
      }),
    );
    expect(added).toEqual([fx.root]);
    run(client, 1);
    expect(calls).toEqual(['fx.events', 'hud.events', 'fx.update', 'hud.update']);
    expect(states[0]).toBe(client.world.getState());
    offFx();
    offHud();
    expect(added).toEqual([]);
    expect(calls.at(-1)).toBe('fx.dispose');
    client.dispose();
  });

  it('pauses on blur and resumes audio on the first gesture', async () => {
    const win = new FakeWindow();
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
      pointerLockElement: null,
      exitPointerLock: () => {},
    });
    const canvas = Object.assign(new EventTarget(), { requestPointerLock: () => {} });
    const audio = new FakeAudio();
    const client = await createClient({
      canvas: canvas as unknown as HTMLCanvasElement,
      touch: false,
      renderer: new FakeRenderer(),
      audio,
      window: win as unknown as ClientWindow,
      document: doc as unknown as Document,
      settings: new SettingsStore(new MemoryStorage()),
      scheduler: MANUAL,
    });
    try {
      expect(client.pointer).not.toBeNull();
      expect(client.session.paused).toBe(false);
      win.dispatchEvent(new Event('blur'));
      expect(client.session.paused).toBe(true);
      win.dispatchEvent(new Event('focus'));
      expect(client.session.paused).toBe(false);

      expect(audio.state).toBe('suspended');
      win.dispatchEvent(new Event('pointerdown'));
      await Promise.resolve();
      await Promise.resolve();
      expect(audio.state).toBe('running');
    } finally {
      client.dispose();
    }
  });

  it('feeds the local pawn from the touch controller when touch is on', async () => {
    const mounted: unknown[] = [];
    const client = await createClient({
      canvas: {} as HTMLCanvasElement,
      touch: true,
      touchSettings: { lookSensitivity: 1, invertY: false },
      mountInputOverlay: (o) => mounted.push(o),
      renderer: new FakeRenderer(),
      audio: false,
      window: new FakeWindow() as unknown as ClientWindow,
      settings: new SettingsStore(new MemoryStorage()),
      scheduler: MANUAL,
      pauseOnBlur: false,
    });
    try {
      expect(client.touch).not.toBeNull();
      expect(client.controller).toBe(client.touch);
      expect(client.pointer).toBeNull();
      expect(mounted).toHaveLength(1);
      run(client, 150);
      const before = findPawn(client.world.getState(), client.localPawn)!;
      expect(before.alive).toBe(true);
      client.touch!.input.stickDown(0, 0, 0);
      client.touch!.input.stickMove(0, -200);
      run(client, 60);
      const after = findPawn(client.world.getState(), client.localPawn)!;
      expect(
        Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z),
      ).toBeGreaterThan(2);
    } finally {
      client.dispose();
    }
    expect(mounted.at(-1)).toBeNull();
  });
});
