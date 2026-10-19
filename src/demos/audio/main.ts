/**
 * Sound board for the audio module, built as `/demos/audio.html`.
 *
 * Plays every catalog sound on the local bus or positionally around the
 * listener (which sits at the origin facing -Z), and runs a short scripted
 * stream of `SimEvent`s through `AudioSystem.handleTick` the way a session does.
 */
import type { VolumeSettings } from '../../app/settings';
import type { AnnouncerLine, SimEvent, Vec3 } from '../../sim/types';
import { NO_ENTITY } from '../../sim/types';
import { AudioSystem } from '../../audio/audioSystem';
import { resumeOnGesture } from '../../audio/resume';
import { announcerSoundId, SOUND_IDS, type SoundId } from '../../audio/sounds';
import { ThreeAudioBackend } from '../../audio/threeBackend';
import { createDemoShell } from '../shell';

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const soundsEl = document.querySelector<HTMLDivElement>('#sounds')!;
const volumeEl = document.querySelector<HTMLDivElement>('#volume')!;
const distanceEl = document.querySelector<HTMLInputElement>('#distance')!;
const angleEl = document.querySelector<HTMLInputElement>('#angle')!;

const DEFAULT_VOLUME: VolumeSettings = { master: 0.8, sfx: 1, music: 0.5, announcer: 1 };
const backend = new ThreeAudioBackend();
const volume: VolumeSettings = { ...DEFAULT_VOLUME };
const audio = new AudioSystem(backend, { volume });
audio.preload();

createDemoShell({
  slug: 'audio',
  tuning: () => ({
    where: where().bus,
    distance: Number(distanceEl.value),
    angle: Number(angleEl.value),
    ...volume,
  }),
});

resumeOnGesture(window, backend.listener.context, () => {
  statusEl.textContent = `Audio running at ${backend.sampleRate} Hz.`;
});

function where(): { bus: 'local' | 'world'; position?: Vec3 } {
  const world = document.querySelector<HTMLInputElement>('input[name=where]:checked')?.value;
  if (world !== 'world') return { bus: 'local' };
  const d = Number(distanceEl.value);
  const a = (Number(angleEl.value) * Math.PI) / 180;
  return { bus: 'world', position: { x: Math.sin(a) * d, y: 0, z: -Math.cos(a) * d } };
}

function playSound(sound: SoundId): void {
  const w = where();
  audio.play({ sound, ...w, volume: 1, rate: 1 });
}

for (const id of SOUND_IDS) {
  const b = document.createElement('button');
  b.textContent = id;
  b.onclick = () => playSound(id);
  soundsEl.append(b);
}

for (const key of ['master', 'sfx', 'music', 'announcer'] as const) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '1';
  input.step = '0.05';
  input.value = String(volume[key]);
  input.oninput = () => {
    volume[key] = Number(input.value);
    audio.setVolume(volume);
  };
  label.append(`${key} `, input);
  volumeEl.append(label);
}

const LINES: AnnouncerLine[] = ['firstBlood', 'doubleKill', 'headshot', 'godlike', 'play'];
document.querySelector<HTMLButtonElement>('#announcer')!.onclick = () => {
  LINES.forEach((line, i) => setTimeout(() => playSound(announcerSoundId(line)), i * 700));
};

/** Two pawns: the local one at the origin, an enemy circling 25 m away. */
document.querySelector<HTMLButtonElement>('#firefight')!.onclick = () => {
  const LOCAL = 1;
  const ENEMY = 2;
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const a = tick * 0.03;
    const enemy: Vec3 = { x: Math.sin(a) * 25, y: 0, z: -Math.cos(a) * 25 };
    const events: SimEvent[] = [];
    if (tick % 16 === 0) events.push({ type: 'footstep', tick, pawn: ENEMY, position: enemy });
    if (tick % 20 === 0)
      events.push({ type: 'footstep', tick, pawn: LOCAL, position: { x: 0, y: 0, z: 0 } });
    if (tick % 50 === 10) {
      events.push({
        type: 'shotFired',
        tick,
        pawn: ENEMY,
        weapon: 'rocket',
        mode: 'primary',
        origin: enemy,
        direction: { x: 0, y: 0, z: 1 },
      });
    }
    if (tick % 50 === 30) {
      events.push(
        {
          type: 'explosion',
          tick,
          position: { x: 3, y: 0, z: -2 },
          radius: 6,
          damageType: 'rocket',
          instigator: ENEMY,
        },
        {
          type: 'damage',
          tick,
          target: LOCAL,
          instigator: ENEMY,
          amount: 30,
          damageType: 'rocket',
          momentum: { x: 0, y: 0, z: 0 },
        },
      );
    }
    if (tick % 40 === 0) {
      events.push(
        {
          type: 'shotFired',
          tick,
          pawn: LOCAL,
          weapon: 'shock',
          mode: 'primary',
          origin: { x: 0, y: 1.6, z: 0 },
          direction: { x: 0, y: 0, z: -1 },
        },
        {
          type: 'hitscan',
          tick,
          pawn: LOCAL,
          weapon: 'shock',
          from: { x: 0, y: 1.6, z: 0 },
          to: enemy,
          hitPawn: ENEMY,
          headshot: false,
        },
        {
          type: 'damage',
          tick,
          target: ENEMY,
          instigator: LOCAL,
          amount: 45,
          damageType: 'shock',
          momentum: { x: 0, y: 0, z: 0 },
        },
      );
    }
    if (tick === 200) {
      events.push(
        { type: 'death', tick, victim: ENEMY, killer: LOCAL, damageType: 'shock', weapon: 'shock' },
        { type: 'announcer', tick, line: 'firstBlood', toPawn: NO_ENTITY },
      );
    }
    audio.handleTick(
      events,
      {
        tick,
        time: tick / 60,
        rngState: 0,
        entities: [
          { id: ENEMY, kind: 'mine', position: enemy, owner: ENEMY, armed: false },
          { id: LOCAL, kind: 'mine', position: { x: 0, y: 0, z: 0 }, owner: LOCAL, armed: false },
        ],
        match: {
          phase: 'playing',
          fragLimit: 0,
          timeLimit: 0,
          elapsed: 0,
          scores: [],
          winner: null,
        },
      },
      LOCAL,
    );
    statusEl.textContent = `tick ${tick}, voices ${audio.activeVoices}`;
    if (tick >= 240) clearInterval(timer);
  }, 1000 / 60);
};

document.body.dataset.ready = '1';
