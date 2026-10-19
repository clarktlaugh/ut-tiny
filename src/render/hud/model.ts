/**
 * HUD view model: pure functions from sim state to what the HUD shows
 * (docs/DESIGN.md §11). No DOM here, so it is testable on its own.
 */
import {
  NO_ENTITY,
  WeaponIds,
  type AnnouncerLine,
  type DamageType,
  type PawnId,
  type PawnState,
  type PlayerScore,
  type MatchState,
  type Seconds,
  type SimEvent,
  type WeaponDef,
  type WeaponId,
  type WeaponSlot,
  type WorldState,
} from '../../sim/types';

export const WEAPON_LABELS: Readonly<Record<WeaponId, string>> = {
  teleporter: 'Translocator',
  assault: 'Assault Rifle',
  mines: 'Mine Layer',
  rocket: 'Rocket Launcher',
  sniper: 'Sniper Rifle',
  shock: 'Shock Rifle',
  shockScoped: 'Super Shock Rifle',
  redeemer: 'Redeemer',
};

export const ANNOUNCER_TEXT: Readonly<Record<AnnouncerLine, string>> = {
  firstBlood: 'First Blood',
  doubleKill: 'Double Kill',
  multiKill: 'Multi Kill',
  megaKill: 'Mega Kill',
  ultraKill: 'Ultra Kill',
  monsterKill: 'M-M-M-Monster Kill',
  killingSpree: 'Killing Spree',
  rampage: 'Rampage',
  dominating: 'Dominating',
  unstoppable: 'Unstoppable',
  godlike: 'Godlike',
  headshot: 'Headshot',
  redeemerAvailable: 'Redeemer Available',
  threeFragsLeft: '3 Frags Left',
  twoFragsLeft: '2 Frags Left',
  oneFragLeft: '1 Frag Left',
  countdown3: '3',
  countdown2: '2',
  countdown1: '1',
  play: 'Play!',
  overtime: 'Overtime',
  youWin: 'You Win!',
  youLose: 'You Lose',
};

/** Crosshair shape per weapon; styling lives in `style.ts`. */
export type CrosshairKind = 'dot' | 'cross' | 'ring' | 'bracket' | 'scope' | 'none';

export const CROSSHAIRS: Readonly<Record<WeaponId, CrosshairKind>> = {
  teleporter: 'ring',
  assault: 'cross',
  mines: 'dot',
  rocket: 'bracket',
  sniper: 'dot',
  shock: 'ring',
  shockScoped: 'ring',
  redeemer: 'bracket',
};

export const KILL_FEED_MAX = 5;
export const KILL_FEED_SECONDS: Seconds = 6;
export const ANNOUNCER_SECONDS: Seconds = 2.5;
export const LOW_HEALTH = 25;

export interface KillFeedEntry {
  text: string;
  /** The local player scored it. */
  mine: boolean;
  /** The local player died in it. */
  against: boolean;
  expiresAt: Seconds;
}

export interface AnnouncerMessage {
  text: string;
  expiresAt: Seconds;
}

export interface WeaponBarSlot {
  slot: WeaponSlot;
  weapon: WeaponId;
  label: string;
  owned: boolean;
  selected: boolean;
  /** Ammo count, `null` for infinite or unowned. */
  ammo: number | null;
}

export interface Readout {
  health: number;
  shield: number;
  lowHealth: boolean;
  alive: boolean;
  ammo: number | null;
  ammoMax: number | null;
  infiniteAmmo: boolean;
  weaponLabel: string;
  crosshair: CrosshairKind;
  /** Magnification readout while zoomed, e.g. `4.0x`, else empty. */
  zoomText: string;
  udamage: boolean;
  protectedSpawn: boolean;
}

export interface StatusText {
  frags: string;
  clock: string;
  phase: string;
}

function whole(n: number): number {
  return Math.max(0, Math.ceil(n));
}

export function readoutFor(
  pawn: PawnState,
  weapons: Readonly<Record<WeaponId, WeaponDef>>,
  tick: number,
): Readout {
  const weapon = pawn.weapon;
  const def = weapon ? weapons[weapon] : null;
  const infiniteAmmo = def !== null && def.ammo === null;
  const ammo = weapon && def?.ammo ? (pawn.ammo[weapon] ?? 0) : null;
  const zoomed = pawn.zoom > 1.001;
  return {
    health: whole(pawn.health),
    shield: whole(pawn.shield),
    lowHealth: pawn.alive && pawn.health <= LOW_HEALTH,
    alive: pawn.alive,
    ammo,
    ammoMax: def?.ammo?.max ?? null,
    infiniteAmmo,
    weaponLabel: weapon ? WEAPON_LABELS[weapon] : '',
    crosshair: !pawn.alive || !weapon ? 'none' : zoomed ? 'scope' : CROSSHAIRS[weapon],
    zoomText: zoomed ? `${pawn.zoom.toFixed(1)}x` : '',
    udamage: pawn.udamageUntil > tick,
    protectedSpawn: pawn.spawnProtectedUntil > tick,
  };
}

export function weaponBarFor(
  pawn: PawnState,
  weapons: Readonly<Record<WeaponId, WeaponDef>>,
): WeaponBarSlot[] {
  const selected = pawn.pendingWeapon ?? pawn.weapon;
  return WeaponIds.map((id) => {
    const def = weapons[id];
    const owned = pawn.owned.includes(id);
    return {
      slot: def.slot,
      weapon: id,
      label: WEAPON_LABELS[id],
      owned,
      selected: owned && id === selected,
      ammo: owned && def.ammo ? (pawn.ammo[id] ?? 0) : null,
    };
  }).sort((a, b) => a.slot - b.slot);
}

export function formatClock(seconds: Seconds): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function statusFor(match: MatchState, playerId: string): StatusText {
  const score = match.scores.find((s) => s.playerId === playerId);
  const left = match.fragLimit > 0 ? ` / ${match.fragLimit}` : '';
  const clock = match.timeLimit > 0 ? match.timeLimit - match.elapsed : match.elapsed;
  const phase =
    match.phase === 'playing' ? '' : match.phase === 'ended' ? 'Match over' : match.phase;
  return { frags: `Frags ${score?.frags ?? 0}${left}`, clock: formatClock(clock), phase };
}

const DAMAGE_VERB: Readonly<Partial<Record<DamageType, string>>> = {
  fall: 'fell too far',
  killVolume: 'was lost',
  damageVolume: 'burned up',
  suicide: 'suicided',
  telefrag: 'was telefragged by',
};

function playerName(
  scores: readonly PlayerScore[],
  state: Readonly<WorldState>,
  pawn: PawnId,
): string {
  const entity = state.entities.find((e) => e.id === pawn);
  const pid = entity && entity.kind === 'pawn' ? entity.playerId : null;
  return scores.find((s) => s.playerId === pid)?.name ?? 'Someone';
}

/** Turns sim events into kill feed entries and announcer messages. */
export function feedFromEvents(
  events: readonly SimEvent[],
  state: Readonly<WorldState>,
  localPawn: PawnId,
): { kills: KillFeedEntry[]; announcements: AnnouncerMessage[] } {
  const kills: KillFeedEntry[] = [];
  const announcements: AnnouncerMessage[] = [];
  const scores = state.match.scores;
  for (const e of events) {
    if (e.type === 'death') {
      const victim = playerName(scores, state, e.victim);
      const killed = e.killer !== NO_ENTITY && e.killer !== e.victim;
      let text: string;
      if (killed) {
        const killer = playerName(scores, state, e.killer);
        const how = e.weapon ? ` [${WEAPON_LABELS[e.weapon]}]` : '';
        text = `${killer} fragged ${victim}${how}`;
      } else if (e.message) {
        text = `${victim} ${e.message}`;
      } else {
        text = `${victim} ${DAMAGE_VERB[e.damageType] ?? 'died'}`;
      }
      kills.push({
        text,
        mine: killed && e.killer === localPawn,
        against: e.victim === localPawn,
        expiresAt: state.time + KILL_FEED_SECONDS,
      });
    } else if (e.type === 'announcer' && (e.toPawn === NO_ENTITY || e.toPawn === localPawn)) {
      announcements.push({
        text: ANNOUNCER_TEXT[e.line],
        expiresAt: state.time + ANNOUNCER_SECONDS,
      });
    }
  }
  return { kills, announcements };
}
