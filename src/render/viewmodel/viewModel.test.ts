import { describe, expect, it } from 'vitest';
import { Box3, Euler, Mesh, Object3D, Vector3, type Camera } from 'three';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import {
  NO_ENTITY,
  WeaponIds,
  type PawnState,
  type SimEvent,
  type Vec3,
  type WeaponId,
} from '../../sim/types';
import {
  DEFAULT_MOTION,
  MOTION_LIMITS,
  ViewModelMotion,
  angleDelta,
  type MotionInput,
} from './motion';
import { FLASH_STYLES, MuzzleFlash, flashStyleFor } from './muzzleFlash';
import { VIEWMODEL_TEST_POSITIONS, testEyeHeight } from './testPositions';
import {
  RECOIL,
  VIEWMODEL_NEAR,
  ViewModel,
  WEAPON_REST,
  viewModelVisible,
  type ViewModelPawn,
  type ViewModelRenderer,
} from './viewModel';
import { WEAPON_MODELS, WeaponModelLibrary } from './weaponModels';

const DT = 1 / 60;

function input(overrides: Partial<MotionInput> = {}): MotionInput {
  return {
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
    ...overrides,
  };
}

function pawn(overrides: Partial<ViewModelPawn> = {}): ViewModelPawn {
  return {
    alive: true,
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
    weapon: 'assault',
    pendingWeapon: null,
    zoom: 1,
    guiding: NO_ENTITY,
    viewingDisc: false,
    ...overrides,
  };
}

/** Run the motion model for `seconds` at `dt` with a fixed input and return the max |offset| seen per field. */
function runMotion(
  motion: ViewModelMotion,
  seconds: number,
  inp: (t: number) => MotionInput,
  dt = DT,
): { x: number; y: number; z: number; pitch: number; yaw: number; roll: number } {
  const max = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const o = motion.step(inp(i * dt), dt);
    for (const k of Object.keys(max) as (keyof typeof max)[]) {
      max[k] = Math.max(max[k], Math.abs(o[k]));
    }
  }
  return max;
}

class FakeRenderer implements ViewModelRenderer {
  autoClear = true;
  calls: string[] = [];
  clearDepth(): void {
    this.calls.push('clearDepth');
  }
  render(scene: Object3D, camera: Camera): void {
    this.calls.push(`render(${scene.name}, ${camera.type}, autoClear=${this.autoClear})`);
  }
}

describe('ViewModelMotion', () => {
  it('rests at zero when standing still', () => {
    const m = new ViewModelMotion();
    const max = runMotion(m, 2, () => input());
    for (const v of Object.values(max)) expect(v).toBeLessThan(1e-9);
  });

  it('bobs while running on the ground, scaled by speed, and not in the air', () => {
    const run = runMotion(new ViewModelMotion(), 3, () =>
      input({ velocity: { x: 0, y: 0, z: -8.8 } }),
    );
    expect(run.x).toBeGreaterThan(DEFAULT_MOTION.bobX * 0.8);
    expect(run.y).toBeGreaterThan(DEFAULT_MOTION.bobY * 0.8);

    const walk = runMotion(new ViewModelMotion(), 3, () =>
      input({ velocity: { x: 0, y: 0, z: -2.2 } }),
    );
    expect(walk.x).toBeLessThan(run.x * 0.5);

    const crouch = runMotion(new ViewModelMotion(), 3, () =>
      input({ velocity: { x: 0, y: 0, z: -8.8 }, crouching: true }),
    );
    expect(crouch.x).toBeLessThan(run.x * 0.7);

    const air = runMotion(new ViewModelMotion(), 3, () =>
      input({ velocity: { x: 0, y: 0, z: -8.8 }, grounded: false }),
    );
    expect(air.x).toBeLessThan(1e-9);
  });

  it('completes one bob cycle per 1 / bobCyclesPerMeter meters', () => {
    const m = new ViewModelMotion();
    // Spin up the amplitude, then sample x over one cycle at 5 m/s.
    runMotion(m, 2.1, () => input({ velocity: { x: 0, y: 0, z: -5 } }));
    const period = 1 / DEFAULT_MOTION.bobCyclesPerMeter / 5;
    const steps = Math.round(period / DT);
    const xs: number[] = [];
    for (let i = 0; i < steps; i++) {
      xs.push(m.step(input({ velocity: { x: 0, y: 0, z: -5 } }), DT).x);
    }
    let crossings = 0;
    for (let i = 1; i < xs.length; i++)
      if (Math.sign(xs[i]!) !== Math.sign(xs[i - 1]!)) crossings++;
    expect(crossings, JSON.stringify(xs)).toBe(2);
  });

  it('sways against the look direction: turning right lags the weapon left', () => {
    const m = new ViewModelMotion();
    let yaw = 0;
    let o = m.step(input(), DT);
    for (let i = 0; i < 20; i++) {
      yaw -= 3 * DT; // turning right at 3 rad/s
      o = m.step(input({ yaw }), DT);
    }
    expect(o.x).toBeLessThan(-0.005);
    expect(o.yaw).toBeGreaterThan(0.02);

    // Looking up drops the weapon.
    const n = new ViewModelMotion();
    let pitch = 0;
    n.step(input(), DT);
    for (let i = 0; i < 20; i++) {
      pitch += 2 * DT;
      o = n.step(input({ pitch }), DT);
    }
    expect(o.y).toBeLessThan(-0.005);
    expect(o.pitch).toBeLessThan(-0.02);
  });

  it('does not sway on the first frame or across the ±π wrap', () => {
    const m = new ViewModelMotion();
    expect(Math.abs(m.step(input({ yaw: 2 }), DT).yaw)).toBe(0);
    const n = new ViewModelMotion();
    n.step(input({ yaw: Math.PI - 0.001 }), DT);
    const o = n.step(input({ yaw: -Math.PI + 0.001 }), DT);
    expect(Math.abs(o.yaw)).toBeLessThan(0.01);
    expect(angleDelta(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
  });

  it('rolls into a strafe', () => {
    const m = new ViewModelMotion();
    // yaw 0: +X is right.
    runMotion(m, 1, () => input({ velocity: { x: 8.8, y: 0, z: 0 } }));
    const o = m.step(input({ velocity: { x: 8.8, y: 0, z: 0 } }), DT);
    expect(o.roll).toBeCloseTo(-DEFAULT_MOTION.strafeRoll, 2);
  });

  it('dips on landing and recovers', () => {
    const m = new ViewModelMotion();
    m.step(input(), DT);
    m.land(15);
    let minY = 0;
    for (let i = 0; i < 10; i++) minY = Math.min(minY, m.step(input(), DT).y);
    expect(minY).toBeLessThan(-0.005);
    runMotion(m, 1.5, () => input());
    expect(Math.abs(m.step(input(), DT).y)).toBeLessThan(1e-3);
  });

  it('kicks back and up on recoil and settles', () => {
    const m = new ViewModelMotion();
    m.step(input(), DT);
    m.recoil({ back: 0.7, pitch: 2.2 });
    let maxZ = 0;
    let maxPitch = 0;
    for (let i = 0; i < 10; i++) {
      const o = m.step(input(), DT);
      maxZ = Math.max(maxZ, o.z);
      maxPitch = Math.max(maxPitch, o.pitch);
    }
    expect(maxZ).toBeGreaterThan(0.01);
    expect(maxPitch).toBeGreaterThan(0.03);
    runMotion(m, 1.5, () => input());
    const o = m.step(input(), DT);
    expect(Math.abs(o.z)).toBeLessThan(1e-3);
    expect(Math.abs(o.pitch)).toBeLessThan(1e-3);
  });

  it('lowers and raises over lowerTime', () => {
    const m = new ViewModelMotion();
    m.setLowerTarget(1);
    const steps = Math.ceil(DEFAULT_MOTION.lowerTime / DT);
    for (let i = 0; i < steps - 1; i++) m.step(input(), DT);
    expect(m.lower).toBeLessThan(1);
    m.step(input(), DT);
    expect(m.lower).toBe(1);
    const o = m.step(input(), DT);
    expect(o.y).toBeCloseTo(-DEFAULT_MOTION.lowerDrop, 5);
    expect(o.pitch).toBeCloseTo(DEFAULT_MOTION.lowerPitch, 5);
    m.setLowerTarget(0);
    for (let i = 0; i < steps; i++) m.step(input(), DT);
    expect(m.lower).toBe(0);
  });

  it('never exceeds MOTION_LIMITS under extreme input', () => {
    const m = new ViewModelMotion();
    const max = runMotion(m, 4, (t) => {
      const i = Math.round(t / DT);
      if (i % 7 === 0) m.recoil({ back: 1, pitch: 3 });
      if (i % 31 === 0) m.land(35);
      return input({
        velocity: { x: 20 * Math.sin(t * 9), y: 30 * Math.cos(t * 5), z: -20 },
        yaw: Math.sin(t * 13) * 3,
        pitch: Math.cos(t * 11) * 1.5,
        grounded: i % 50 < 25,
      });
    });
    expect(max.x).toBeLessThanOrEqual(MOTION_LIMITS.position);
    expect(max.y).toBeLessThanOrEqual(MOTION_LIMITS.position);
    expect(max.z).toBeLessThanOrEqual(MOTION_LIMITS.position);
    expect(max.pitch).toBeLessThanOrEqual(MOTION_LIMITS.rotation);
    expect(max.yaw).toBeLessThanOrEqual(MOTION_LIMITS.rotation);
    expect(max.roll).toBeLessThanOrEqual(MOTION_LIMITS.rotation);
  });

  it('is roughly frame-rate independent', () => {
    const at = (dt: number) => {
      const m = new ViewModelMotion();
      runMotion(m, 1, () => input({ velocity: { x: 3, y: 0, z: -8 } }), dt);
      m.recoil({ back: 0.5, pitch: 2 });
      runMotion(m, 0.05, () => input({ velocity: { x: 3, y: 0, z: -8 } }), dt);
      return m.step(input({ velocity: { x: 3, y: 0, z: -8 } }), 0);
    };
    const a = at(1 / 60);
    const b = at(1 / 144);
    expect(a.x).toBeCloseTo(b.x, 2);
    expect(a.y).toBeCloseTo(b.y, 2);
    expect(a.z).toBeCloseTo(b.z, 2);
    expect(a.roll).toBeCloseTo(b.roll, 2);
  });
});

describe('weapon models', () => {
  const lib = new WeaponModelLibrary();

  it('has a distinct placeholder for every weapon', () => {
    for (const id of WeaponIds) {
      const def = WEAPON_MODELS[id];
      expect(def.parts.length).toBeGreaterThan(2);
      const model = lib.get(id);
      expect(model.id).toBe(id);
      expect(model.root.children.filter((c) => c instanceof Mesh).length).toBe(def.parts.length);
      expect(model.muzzle.name).toBe('muzzle');
      expect(lib.get(id)).toBe(model);
    }
    const colors = new Set(WeaponIds.map((id) => WEAPON_MODELS[id].bodyColor));
    expect(colors.size).toBe(WeaponIds.length);
  });

  /** Camera-space bounds of the weapon at the rest pose plus an offset. */
  function cameraBounds(id: WeaponId, off: Vec3, rot: Euler): Box3 {
    const rig = new Object3D();
    rig.position.set(WEAPON_REST.x + off.x, WEAPON_REST.y + off.y, WEAPON_REST.z + off.z);
    rig.rotation.copy(rot);
    const root = lib.get(id).root.clone();
    rig.add(root);
    rig.updateMatrixWorld(true);
    return new Box3().setFromObject(rig, true);
  }

  it('stays clear of the view-model near plane at every motion extreme', () => {
    const P = MOTION_LIMITS.position;
    const R = MOTION_LIMITS.rotation;
    for (const id of WeaponIds) {
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1])
            for (const rp of [-R, 0, R])
              for (const ry of [-R, R])
                for (const rr of [-R, R]) {
                  const b = cameraBounds(
                    id,
                    { x: sx * P, y: sy * P, z: sz * P },
                    new Euler(rp, ry, rr, 'YXZ'),
                  );
                  // Camera looks down −Z; everything must be beyond the near plane with margin.
                  expect(b.max.z, id).toBeLessThan(-VIEWMODEL_NEAR - 0.05);
                }
    }
  });

  it('puts every muzzle on screen at rest', () => {
    const vm = new ViewModel();
    vm.camera.updateMatrixWorld(true);
    for (const id of WeaponIds) {
      const rig = new Object3D();
      rig.position.set(WEAPON_REST.x, WEAPON_REST.y, WEAPON_REST.z);
      const model = lib.get(id).root.clone();
      rig.add(model);
      rig.updateMatrixWorld(true);
      const muzzle = model.getObjectByName('muzzle')!;
      const p = muzzle.getWorldPosition(new Vector3()).project(vm.camera);
      expect(Math.abs(p.x), id).toBeLessThan(1);
      expect(Math.abs(p.y), id).toBeLessThan(1);
      expect(p.z, id).toBeGreaterThan(-1);
      expect(p.z, id).toBeLessThan(1);
    }
    vm.dispose();
  });
});

describe('muzzle flash', () => {
  it('has a style per fire mode that shoots something, and none for the translocator', () => {
    expect(flashStyleFor('teleporter', 'primary')).toBeNull();
    expect(flashStyleFor('teleporter', 'alt')).toBeNull();
    for (const id of WeaponIds) {
      if (id === 'teleporter') continue;
      expect(FLASH_STYLES[id].primary, id).not.toBeNull();
    }
  });

  it('fades out over its duration and follows the muzzle', () => {
    const flash = new MuzzleFlash();
    const muzzle = new Object3D();
    muzzle.position.set(0.1, -0.1, -0.7);
    const style = flashStyleFor('rocket', 'primary')!;
    flash.trigger(style);
    flash.update(DT / 4, muzzle);
    expect(flash.active).toBe(true);
    expect(flash.object.visible).toBe(true);
    expect(flash.object.position.distanceTo(muzzle.position)).toBeLessThan(1e-9);
    expect(flash.light.intensity).toBeGreaterThan(style.light * 0.5);
    flash.update(style.duration, muzzle);
    expect(flash.active).toBe(false);
    expect(flash.object.visible).toBe(false);
    expect(flash.light.intensity).toBe(0);
    flash.dispose();
  });
});

describe('viewModelVisible', () => {
  it('follows the view-target and pawn state', () => {
    expect(viewModelVisible(pawn())).toBe(true);
    expect(viewModelVisible(undefined)).toBe(false);
    expect(viewModelVisible(pawn(), false)).toBe(false);
    expect(viewModelVisible(pawn({ alive: false }))).toBe(false);
    expect(viewModelVisible(pawn({ weapon: null }))).toBe(false);
    expect(viewModelVisible(pawn({ weapon: null, pendingWeapon: 'rocket' }))).toBe(true);
    expect(viewModelVisible(pawn({ weapon: 'sniper', zoom: 2 }))).toBe(false);
    expect(viewModelVisible(pawn({ weapon: 'redeemer', guiding: 42 }))).toBe(false);
    expect(viewModelVisible(pawn({ weapon: 'teleporter', viewingDisc: true }))).toBe(false);
  });
});

describe('ViewModel', () => {
  const shot = (
    pawnId: number,
    weapon: WeaponId,
    mode: 'primary' | 'alt' = 'primary',
  ): SimEvent => ({
    type: 'shotFired',
    tick: 1,
    pawn: pawnId,
    weapon,
    mode,
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
  });

  it('draws in a second pass after clearing depth, and restores autoClear', () => {
    const vm = new ViewModel();
    const r = new FakeRenderer();
    vm.update(pawn(), DT);
    vm.render(r);
    expect(r.calls).toEqual([
      'clearDepth',
      'render(viewmodel, PerspectiveCamera, autoClear=false)',
    ]);
    expect(r.autoClear).toBe(true);
    vm.dispose();
  });

  it('draws nothing while hidden', () => {
    const vm = new ViewModel();
    const r = new FakeRenderer();
    vm.update(pawn({ alive: false }), DT);
    vm.render(r);
    vm.update(pawn(), DT, false);
    vm.render(r);
    expect(r.calls).toEqual([]);
    expect(vm.visible).toBe(false);
    vm.dispose();
  });

  it('raises the first weapon from below', () => {
    const vm = new ViewModel();
    vm.update(pawn({ weapon: 'assault' }), 0);
    expect(vm.displayedWeapon).toBe('assault');
    expect(vm.motion.lower).toBe(1);
    for (let i = 0; i < 12; i++) vm.update(pawn(), DT);
    expect(vm.motion.lower).toBe(0);
    vm.dispose();
  });

  it('lowers, swaps at the bottom and raises during a weapon switch', () => {
    const vm = new ViewModel();
    for (let i = 0; i < 20; i++) vm.update(pawn({ weapon: 'assault' }), DT);
    expect(vm.motion.lower).toBe(0);

    // 0.3 s sim switch: pendingWeapon set for 18 ticks, then weapon changes.
    const switching = pawn({ weapon: 'assault', pendingWeapon: 'rocket' });
    const seen: (WeaponId | null)[] = [];
    for (let i = 0; i < 18; i++) {
      vm.update(switching, DT);
      seen.push(vm.displayedWeapon);
    }
    expect(seen[0]).toBe('assault');
    expect(seen[17]).toBe('rocket');
    const swapAt = seen.indexOf('rocket');
    expect(swapAt * DT).toBeGreaterThanOrEqual(DEFAULT_MOTION.lowerTime - DT);
    expect(vm.motion.lower).toBeLessThan(0.3);
    for (let i = 0; i < 10; i++) vm.update(pawn({ weapon: 'rocket' }), DT);
    expect(vm.displayedWeapon).toBe('rocket');
    expect(vm.motion.lower).toBe(0);
    vm.dispose();
  });

  it('flashes and kicks on the local pawn’s shots only', () => {
    const vm = new ViewModel();
    for (let i = 0; i < 20; i++) vm.update(pawn({ weapon: 'rocket' }), DT);
    vm.handleEvents([shot(7, 'rocket')], 1);
    expect(vm.flash.active).toBe(false);

    vm.handleEvents([shot(1, 'rocket')], 1);
    expect(vm.flash.active).toBe(true);
    vm.update(pawn({ weapon: 'rocket' }), DT);
    expect(vm.flash.object.visible).toBe(true);
    const muzzle = vm.muzzle!.getWorldPosition(new Vector3());
    expect(vm.flash.object.position.distanceTo(muzzle)).toBeLessThan(1e-9);
    let maxZ = 0;
    for (let i = 0; i < 6; i++) {
      vm.update(pawn({ weapon: 'rocket' }), DT);
      maxZ = Math.max(maxZ, vm.motion.step(input(), 0).z);
    }
    expect(maxZ).toBeGreaterThan(0.01);
    for (let i = 0; i < 20; i++) vm.update(pawn({ weapon: 'rocket' }), DT);
    expect(vm.flash.active).toBe(false);

    // The translocator kicks but never flashes.
    vm.handleEvents([shot(1, 'teleporter')], 1);
    expect(vm.flash.active).toBe(false);
    expect(RECOIL.teleporter?.primary).toBeDefined();
    vm.dispose();
  });

  it('cuts the flash when the view model hides and redraws after a respawn', () => {
    const vm = new ViewModel();
    for (let i = 0; i < 20; i++) vm.update(pawn({ weapon: 'shock' }), DT);
    vm.handleEvents([shot(1, 'shock')], 1);
    vm.update(pawn({ alive: false, weapon: 'shock' }), DT);
    expect(vm.flash.active).toBe(false);

    vm.handleEvents(
      [
        {
          type: 'respawn',
          tick: 2,
          pawn: 1,
          pose: { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 },
        },
      ],
      1,
    );
    expect(vm.displayedWeapon).toBeNull();
    vm.update(pawn({ weapon: 'assault' }), DT);
    expect(vm.displayedWeapon).toBe('assault');
    expect(vm.motion.lower).toBeGreaterThan(0.8);
    vm.dispose();
  });

  it('dips on the local pawn landing', () => {
    const vm = new ViewModel();
    for (let i = 0; i < 20; i++) vm.update(pawn(), DT);
    vm.handleEvents([{ type: 'land', tick: 1, pawn: 1, impactSpeed: 20 }], 1);
    let minY = 0;
    for (let i = 0; i < 10; i++) {
      vm.update(pawn(), DT);
      minY = Math.min(minY, vm.motion.step(input(), 0).y);
    }
    expect(minY).toBeLessThan(-0.005);
    vm.dispose();
  });

  it('updates its own camera aspect on resize and keeps its own FOV', () => {
    const vm = new ViewModel({ fov: 50 });
    vm.resize(1000, 500);
    expect(vm.camera.aspect).toBe(2);
    expect(vm.camera.fov).toBe(50);
    vm.resize(0, 10);
    expect(vm.camera.aspect).toBe(2);
    vm.dispose();
  });

  it('accepts a full PawnState', () => {
    const full: PawnState = {
      id: 1,
      kind: 'pawn',
      playerId: 'local',
      position: { x: 0, y: 0.9, z: 0 },
      health: 100,
      shield: 0,
      owned: ['assault'],
      ammo: {},
      spawnProtectedUntil: 0,
      respawnAt: 0,
      disc: NO_ENTITY,
      udamageUntil: 0,
      ...pawn(),
    };
    const vm = new ViewModel();
    vm.update(full, DT);
    expect(vm.visible).toBe(true);
    vm.dispose();
  });
});

describe('clipping test positions (Laundry Room)', () => {
  const boxes = LAUNDRY_ROOM.brushes
    .filter((b) => b.shape === 'box' && !b.yaw)
    .map((b) => ({
      min: {
        x: b.position.x - b.size.x / 2,
        y: b.position.y - b.size.y / 2,
        z: b.position.z - b.size.z / 2,
      },
      max: {
        x: b.position.x + b.size.x / 2,
        y: b.position.y + b.size.y / 2,
        z: b.position.z + b.size.z / 2,
      },
    }));

  /** Distance along a ray to the nearest box, or Infinity. */
  function rayHit(o: Vec3, d: Vec3): number {
    let best = Infinity;
    for (const b of boxes) {
      let t0 = 0;
      let t1 = Infinity;
      let ok = true;
      for (const a of ['x', 'y', 'z'] as const) {
        if (Math.abs(d[a]) < 1e-12) {
          if (o[a] < b.min[a] || o[a] > b.max[a]) ok = false;
          continue;
        }
        let ta = (b.min[a] - o[a]) / d[a];
        let tb = (b.max[a] - o[a]) / d[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
      if (ok && t0 <= t1) best = Math.min(best, t0);
    }
    return best;
  }

  it('has a set of named positions', () => {
    expect(VIEWMODEL_TEST_POSITIONS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(VIEWMODEL_TEST_POSITIONS.map((p) => p.name)).size).toBe(
      VIEWMODEL_TEST_POSITIONS.length,
    );
  });

  for (const pos of VIEWMODEL_TEST_POSITIONS) {
    it(`${pos.name}: eye is outside geometry and faces a surface within 1 m`, () => {
      const eye = { x: pos.feet.x, y: pos.feet.y + testEyeHeight(pos), z: pos.feet.z };
      for (const b of boxes) {
        const inside =
          eye.x > b.min.x &&
          eye.x < b.max.x &&
          eye.y > b.min.y &&
          eye.y < b.max.y &&
          eye.z > b.min.z &&
          eye.z < b.max.z;
        expect(inside).toBe(false);
      }
      const cp = Math.cos(pos.pitch);
      const dir = {
        x: -Math.sin(pos.yaw) * cp,
        y: Math.sin(pos.pitch),
        z: -Math.cos(pos.yaw) * cp,
      };
      const t = rayHit(eye, dir);
      // Flush against the surface: the eye is the capsule radius (0.4 m) away, give or take angle.
      expect(t).toBeGreaterThan(0.3);
      expect(t).toBeLessThan(1);
    });
  }
});
