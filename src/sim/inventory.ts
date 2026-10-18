/**
 * Weapon inventory and switching (docs/DESIGN.md §5 common rules, §6).
 *
 * The inventory lives on `PawnState` (`weapon`, `pendingWeapon`, `owned`,
 * `ammo`) plus one sim-private timer in `InventoryState` (when the current
 * switch completes), so the renderer and HUD read everything they need from
 * the snapshot.
 *
 * Switching: a request for a different owned weapon sets `pendingWeapon` and
 * completes `WeaponDef.switchTime` (§5: 0.3 s) later, when `weapon` changes and
 * a `weaponSwitched` event is emitted. No weapon can fire while a switch is
 * pending. Requesting the held weapon during a switch cancels it. The weapon
 * table is passed in (`src/data/weapons.ts` lands with P13), so nothing here
 * hard-codes weapon stats.
 */
import {
  Buttons,
  NO_ENTITY,
  TICK_RATE,
  type InputCommand,
  type PawnState,
  type SimEvent,
  type Tick,
  type WeaponDef,
  type WeaponId,
} from './types';

export type WeaponTable = Readonly<Record<WeaponId, Readonly<WeaponDef>>>;

/** Sim-private inventory timers for one pawn (not part of the snapshot). */
export interface InventoryState {
  /** Tick at which `pendingWeapon` becomes `weapon`. Meaningful while a switch is pending. */
  switchDoneAt: Tick;
}

/**
 * Weapons a pawn spawns with: translocator and assault rifle, as in UT2004
 * deathmatch. The highest-priority one is equipped.
 */
export const DEFAULT_LOADOUT: readonly WeaponId[] = Object.freeze([
  'teleporter',
  'assault',
] as WeaponId[]);

export function createInventoryState(): InventoryState {
  return { switchDoneAt: 0 };
}

/** Ticks a switch to `def` takes. */
export function switchTicks(def: Readonly<WeaponDef>): number {
  return Math.max(0, Math.round(def.switchTime * TICK_RATE));
}

/** The weapon in a bar slot (1–8), or undefined. */
export function weaponForSlot(weapons: WeaponTable, slot: number): WeaponId | undefined {
  for (const id of Object.keys(weapons) as WeaponId[]) {
    if (weapons[id].slot === slot) return id;
  }
  return undefined;
}

export function owns(pawn: Readonly<PawnState>, weapon: WeaponId): boolean {
  return pawn.owned.includes(weapon);
}

/** Current ammo for `weapon`; `Infinity` for infinite-ammo weapons. */
export function ammoOf(pawn: Readonly<PawnState>, weapon: WeaponId, weapons: WeaponTable): number {
  if (weapons[weapon].ammo === null) return Infinity;
  return pawn.ammo[weapon] ?? 0;
}

/** True if the pawn has enough ammo for one shot of either fire mode of `weapon`. */
export function hasAmmo(
  pawn: Readonly<PawnState>,
  weapon: WeaponId,
  weapons: WeaponTable,
): boolean {
  const def = weapons[weapon];
  if (def.ammo === null) return true;
  const need = Math.min(
    Math.max(def.primary.ammoPerShot, 1),
    def.alt.behavior === 'none' ? Infinity : Math.max(def.alt.ammoPerShot, 1),
  );
  return ammoOf(pawn, weapon, weapons) >= need;
}

/** Add ammo up to `AmmoDef.max`. Returns the amount actually added (0 for infinite ammo). */
export function addAmmo(
  pawn: PawnState,
  weapon: WeaponId,
  amount: number,
  weapons: WeaponTable,
): number {
  const ammo = weapons[weapon].ammo;
  if (ammo === null || amount <= 0) return 0;
  const current = pawn.ammo[weapon] ?? 0;
  const next = Math.min(ammo.max, current + amount);
  const added = Math.max(0, next - current);
  pawn.ammo[weapon] = Math.max(current, next);
  return added;
}

/**
 * Spend `count` ammo for a shot. Returns false (and spends nothing) when there
 * is not enough. Infinite-ammo weapons always succeed.
 */
export function consumeAmmo(
  pawn: PawnState,
  weapon: WeaponId,
  count: number,
  weapons: WeaponTable,
): boolean {
  if (weapons[weapon].ammo === null || count <= 0) return true;
  const current = pawn.ammo[weapon] ?? 0;
  if (current < count) return false;
  pawn.ammo[weapon] = current - count;
  return true;
}

/** The weapon the pawn is switching to or holding. */
export function targetWeapon(pawn: Readonly<PawnState>): WeaponId | null {
  return pawn.pendingWeapon ?? pawn.weapon;
}

/** True when the held weapon may fire this tick (alive, holding one, not mid-switch). */
export function canFire(pawn: Readonly<PawnState>): boolean {
  return pawn.alive && pawn.weapon !== null && pawn.pendingWeapon === null;
}

/** Highest-priority owned weapon with ammo, or null. */
export function bestWeapon(pawn: Readonly<PawnState>, weapons: WeaponTable): WeaponId | null {
  let best: WeaponId | null = null;
  for (const id of pawn.owned) {
    if (!hasAmmo(pawn, id, weapons)) continue;
    if (best === null || weapons[id].priority > weapons[best].priority) best = id;
  }
  return best;
}

/**
 * Start switching to `weapon`. Ignored for unowned weapons, while guiding a
 * Redeemer (§5.1) and when it is already the target. Requesting the held
 * weapon mid-switch cancels the switch. With no weapon held the switch is
 * instant. Returns the events emitted (a `weaponSwitched` only when instant).
 */
export function requestSwitch(
  pawn: PawnState,
  inv: InventoryState,
  weapon: WeaponId,
  tick: Tick,
  weapons: WeaponTable,
): SimEvent[] {
  if (!pawn.alive || !owns(pawn, weapon) || pawn.guiding !== NO_ENTITY) return [];
  if (weapon === targetWeapon(pawn)) return [];
  if (weapon === pawn.weapon) {
    pawn.pendingWeapon = null;
    return [];
  }
  if (pawn.weapon === null) return [equip(pawn, weapon, tick)];
  pawn.pendingWeapon = weapon;
  pawn.zoom = 1;
  inv.switchDoneAt = tick + switchTicks(weapons[weapon]);
  if (inv.switchDoneAt <= tick) return completeSwitch(pawn, tick);
  return [];
}

/** Next (`dir` = 1) or previous (−1) owned weapon with ammo in slot order, wrapping. */
export function cycleWeapon(
  pawn: Readonly<PawnState>,
  dir: 1 | -1,
  weapons: WeaponTable,
): WeaponId | null {
  const usable = pawn.owned
    .filter((id) => hasAmmo(pawn, id, weapons))
    .sort((a, b) => weapons[a].slot - weapons[b].slot);
  if (usable.length === 0) return null;
  const current = targetWeapon(pawn);
  const index = current === null ? -1 : usable.indexOf(current);
  if (index === -1) return dir === 1 ? (usable[0] ?? null) : (usable[usable.length - 1] ?? null);
  return usable[(index + dir + usable.length) % usable.length] ?? null;
}

/**
 * Per-tick inventory update from the pawn's input: slot requests,
 * NextWeapon / PrevWeapon, and completing a pending switch. Run before firing.
 */
export function tickInventory(
  pawn: PawnState,
  inv: InventoryState,
  input: Readonly<InputCommand>,
  tick: Tick,
  weapons: WeaponTable,
): SimEvent[] {
  if (!pawn.alive) return [];
  const events: SimEvent[] = [];

  let wanted: WeaponId | null | undefined;
  if (input.weapon > 0) wanted = weaponForSlot(weapons, input.weapon);
  else if (input.buttons & Buttons.NextWeapon) wanted = cycleWeapon(pawn, 1, weapons);
  else if (input.buttons & Buttons.PrevWeapon) wanted = cycleWeapon(pawn, -1, weapons);
  if (wanted) events.push(...requestSwitch(pawn, inv, wanted, tick, weapons));

  if (pawn.pendingWeapon !== null && tick >= inv.switchDoneAt) {
    events.push(...completeSwitch(pawn, tick));
  }
  return events;
}

/**
 * Give a weapon (weapon pickup or spawn loadout). A new weapon arrives with
 * its starting ammo on top of any ammo already collected; an owned one is
 * topped up to at least its starting ammo. With `autoSwitch`, a newly gained
 * weapon stronger than the current one is switched to (§5).
 */
export function giveWeapon(
  pawn: PawnState,
  inv: InventoryState,
  weapon: WeaponId,
  tick: Tick,
  weapons: WeaponTable,
  autoSwitch = true,
): SimEvent[] {
  const def = weapons[weapon];
  const isNew = !owns(pawn, weapon);
  if (isNew) pawn.owned.push(weapon);
  if (def.ammo !== null) {
    const current = pawn.ammo[weapon] ?? 0;
    const target = isNew ? current + def.ammo.start : Math.max(current, def.ammo.start);
    pawn.ammo[weapon] = Math.max(current, Math.min(def.ammo.max, target));
  }
  if (!isNew || !pawn.alive) return [];
  const current = targetWeapon(pawn);
  if (current === null) return [equip(pawn, weapon, tick)];
  if (autoSwitch && def.priority > weapons[current].priority) {
    return requestSwitch(pawn, inv, weapon, tick, weapons);
  }
  return [];
}

/**
 * Reset to the spawn loadout: own exactly `loadout`, each with its starting
 * ammo, holding the highest-priority one immediately (no switch delay or event).
 */
export function resetInventory(
  pawn: PawnState,
  inv: InventoryState,
  loadout: readonly WeaponId[],
  weapons: WeaponTable,
): void {
  pawn.owned = [];
  pawn.ammo = {};
  pawn.weapon = null;
  pawn.pendingWeapon = null;
  pawn.zoom = 1;
  inv.switchDoneAt = 0;
  for (const id of loadout) {
    if (owns(pawn, id)) continue;
    pawn.owned.push(id);
    const ammo = weapons[id].ammo;
    if (ammo !== null) pawn.ammo[id] = Math.min(ammo.start, ammo.max);
  }
  pawn.weapon = bestWeapon(pawn, weapons) ?? pawn.owned[0] ?? null;
}

/**
 * After a shot empties the held weapon, switch to the best weapon that still
 * has ammo (UT behavior). Returns the events from the switch, if any.
 */
export function switchIfEmpty(
  pawn: PawnState,
  inv: InventoryState,
  tick: Tick,
  weapons: WeaponTable,
): SimEvent[] {
  const held = pawn.weapon;
  if (held === null || pawn.pendingWeapon !== null || hasAmmo(pawn, held, weapons)) return [];
  const best = bestWeapon(pawn, weapons);
  return best === null ? [] : requestSwitch(pawn, inv, best, tick, weapons);
}

function equip(pawn: PawnState, weapon: WeaponId, tick: Tick): SimEvent {
  pawn.weapon = weapon;
  pawn.pendingWeapon = null;
  pawn.zoom = 1;
  return { type: 'weaponSwitched', tick, pawn: pawn.id, weapon };
}

function completeSwitch(pawn: PawnState, tick: Tick): SimEvent[] {
  const next = pawn.pendingWeapon;
  if (next === null) return [];
  return [equip(pawn, next, tick)];
}
