/**
 * Weapon contract (docs/DESIGN.md §5, §5.1). Implemented by P12–P14 and M4.
 */
import { describe, it } from 'vitest';

describe('damage pipeline', () => {
  it.todo('shield absorbs damage before health');
  it.todo('own splash damage is scaled by 0.5');
  it.todo('every damage event carries a momentum vector that moves the target');
  it.todo('health above 100 decays at 1 per second');
  it.todo('spawn protection blocks damage until it expires or the pawn fires');
  it.todo('death emits a death event with killer, damageType and weapon');
});

describe('inventory', () => {
  it.todo('switching weapons takes 0.3 s and emits weaponSwitched when complete');
  it.todo('weapon slot request for an unowned weapon is ignored');
  it.todo('auto-switch on pickup only when the new weapon has higher priority');
  it.todo('ammo never exceeds AmmoDef.max');
});

describe('fire behaviors', () => {
  it.todo('hitscan hits the first pawn along the ray and emits a hitscan event');
  it.todo('hitscan headshot applies headshotMultiplier');
  it.todo('projectile travels at projectileSpeed and explodes on contact');
  it.todo('splash damage falls off linearly to zero at splashRadius');
  it.todo('lob bounces and detonates at fuse or on pawn contact');
  it.todo('rocket launcher loads up to 3 while fire is held and fires them all on release');
  it.todo('super shock rifle one-shots a 199 health + 150 shield pawn');
  it.todo('redeemer warhead has 50 hp and fizzles when destroyed in flight');
  it.todo('mines arm 1 s after landing and detonate when an enemy is within 4 m');
  it.todo('at most 4 mines per owner; a 5th replaces the oldest');
});

describe('translocator (§5.1)', () => {
  it.todo('primary with no disc out throws a disc');
  it.todo('primary tap with a disc out recalls it');
  it.todo('holding CamView with a disc out sets pawn.viewingDisc');
  it.todo('alt with a disc out teleports the pawn to the disc and recalls it');
  it.todo('teleporting onto an occupied spot telefrags the occupant');
  it.todo('teleporting to a disrupted disc kills the user');
  it.todo('teleport while viewingDisc faces the pawn along the camera direction');
  it.todo('an enemy hitscan or projectile on the disc marks it disrupted');
  it.todo('the owner dying recalls the disc');
});

describe('redeemer guidance (§5.1)', () => {
  it.todo('alt fire launches a guided warhead and sets pawn.guiding');
  it.todo('while guiding, yaw/pitch input steers at most 70°/s yaw and 50°/s pitch');
  it.todo('while guiding, movement input is ignored and the pawn cannot switch weapons');
  it.todo('primary fire while guiding detonates the warhead');
  it.todo('the guiding pawn dying detonates the warhead in place');
  it.todo('destroying the warhead emits guidanceEnded and projectileDestroyed');
});
