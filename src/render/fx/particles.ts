/**
 * Pooled sprite particles (docs/DESIGN.md §8.3, §12).
 *
 * One `ParticleLayer` is one draw call: an instanced quad billboarded in the
 * vertex shader, with per-instance position, color + alpha, size, atlas frame
 * and rotation. Everything is preallocated for `capacity` particles; live
 * particles are kept dense at the front of the instance buffers so
 * `instanceCount` is the live count. Simulation (velocity, gravity, drag,
 * size and color ramps) runs on the CPU in typed arrays.
 *
 * Two layers cover the usual needs: an additive one for light (glows, sparks,
 * fire) and an alpha-blended one for matter (smoke, dust, blood).
 */
import {
  AdditiveBlending,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  type Texture,
} from 'three';
import type { Vec3 } from '../../sim/types';
import { ATLAS_CELLS } from './atlas';
import { AllocationCounter, SlotPool } from './pool';

/** Blend mode of a layer. */
export type ParticleBlend = 'additive' | 'alpha';

/** Spawn parameters. Reuse one object per emitter; the layer copies the values. */
export interface ParticleSpawn {
  position: Vec3;
  velocity: Vec3;
  /** Seconds to live. */
  life: number;
  /** Size (quad side in meters) at birth and at death. */
  size0: number;
  size1: number;
  /** Color (0xRRGGBB) at birth and at death. */
  color0: number;
  color1: number;
  /** Alpha at birth and at death. */
  alpha0: number;
  alpha1: number;
  /** Atlas frame. */
  frame: number;
  /** Rotation in radians, and spin in radians per second. */
  rotation: number;
  spin: number;
  /** Gravity scale (1 = full §4 gravity, 0 = floats). */
  gravity: number;
  /** Velocity damping per second (0 = none; 3 stops quickly). */
  drag: number;
}

/** §4 gravity, used by sparks, debris and gibs. */
export const FX_GRAVITY = 19;

const FLOATS_PER_PARTICLE = 16;
// Layout of `state` per particle.
const VX = 0;
const VY = 1;
const VZ = 2;
const AGE = 3;
const LIFE = 4;
const SIZE0 = 5;
const SIZE1 = 6;
const R0 = 7;
const G0 = 8;
const B0 = 9;
const R1 = 10;
const G1 = 11;
const B1 = 12;
const ALPHA0 = 13;
const ALPHA1 = 14;
const GRAV = 15;
// Drag, spin and rotation live in their own small arrays.

const VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute float iSize;
attribute float iFrame;
attribute float iRot;
uniform float uCells;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vColor = iColor;
  float c = cos(iRot);
  float s = sin(iRot);
  vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSize;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += corner;
  gl_Position = projectionMatrix * mv;
  float col = mod(iFrame, uCells);
  float row = floor(iFrame / uCells);
  vUv = (uv + vec2(col, uCells - 1.0 - row)) / uCells;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float m = texture2D(uMap, vUv).a;
  #ifdef ADDITIVE
    gl_FragColor = vec4(vColor.rgb * m * vColor.a, m * vColor.a);
  #else
    gl_FragColor = vec4(vColor.rgb, vColor.a * m);
  #endif
  if (gl_FragColor.a < 0.002) discard;
}
`;

/** Unpack 0xRRGGBB into 0..1 components. */
export function unpackColor(hex: number, out: Float32Array, offset: number): void {
  out[offset] = ((hex >> 16) & 0xff) / 255;
  out[offset + 1] = ((hex >> 8) & 0xff) / 255;
  out[offset + 2] = (hex & 0xff) / 255;
}

export class ParticleLayer {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly pool: SlotPool;
  readonly allocations = new AllocationCounter();

  private readonly state: Float32Array;
  private readonly drag: Float32Array;
  private readonly spin: Float32Array;
  private readonly rot: Float32Array;
  /** Dense (instance-ordered) GPU attributes, rewritten from the slot-ordered arrays each update. */
  private readonly posAttr: InstancedBufferAttribute;
  private readonly colorAttr: InstancedBufferAttribute;
  private readonly sizeAttr: InstancedBufferAttribute;
  private readonly frameAttr: InstancedBufferAttribute;
  private readonly rotAttr: InstancedBufferAttribute;
  private readonly pos: Float32Array;
  private readonly frame: Float32Array;

  constructor(
    readonly blend: ParticleBlend,
    atlas: Texture,
    readonly capacity: number,
  ) {
    const a = this.allocations;
    this.pool = a.track(new SlotPool(capacity));
    this.state = a.track(new Float32Array(capacity * FLOATS_PER_PARTICLE));
    this.drag = a.track(new Float32Array(capacity));
    this.spin = a.track(new Float32Array(capacity));
    this.rot = a.track(new Float32Array(capacity));
    this.pos = a.track(new Float32Array(capacity * 3));
    this.frame = a.track(new Float32Array(capacity));

    const geometry = a.track(new InstancedBufferGeometry());
    // Unit quad, two triangles.
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const dyn = (array: Float32Array, size: number): InstancedBufferAttribute => {
      const attr = new InstancedBufferAttribute(array, size);
      attr.setUsage(DynamicDrawUsage);
      return attr;
    };
    // Attribute arrays are dense (instance order); the arrays above are slot-ordered.
    this.posAttr = a.track(dyn(new Float32Array(capacity * 3), 3));
    this.colorAttr = a.track(dyn(new Float32Array(capacity * 4), 4));
    this.sizeAttr = a.track(dyn(new Float32Array(capacity), 1));
    this.frameAttr = a.track(dyn(new Float32Array(capacity), 1));
    this.rotAttr = a.track(dyn(new Float32Array(capacity), 1));
    geometry.setAttribute('iPos', this.posAttr);
    geometry.setAttribute('iColor', this.colorAttr);
    geometry.setAttribute('iSize', this.sizeAttr);
    geometry.setAttribute('iFrame', this.frameAttr);
    geometry.setAttribute('iRot', this.rotAttr);
    geometry.instanceCount = 0;

    const material = a.track(
      new ShaderMaterial({
        uniforms: { uMap: { value: atlas }, uCells: { value: ATLAS_CELLS } },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        defines: blend === 'additive' ? { ADDITIVE: 1 } : {},
        transparent: true,
        depthWrite: false,
        blending: blend === 'additive' ? AdditiveBlending : NormalBlending,
      }),
    );
    this.mesh = a.track(new Mesh(geometry, material));
    this.mesh.name = `fx-particles-${blend}`;
    this.mesh.frustumCulled = false;
    // Smoke draws before light so glows sit on top of it.
    this.mesh.renderOrder = blend === 'additive' ? 20 : 10;
  }

  /** Live particle count. */
  get size(): number {
    return this.pool.size;
  }

  /** Spawn one particle. Recycles the oldest when full. */
  emit(p: Readonly<ParticleSpawn>): void {
    const slot = this.pool.acquire();
    const s = this.state;
    const o = slot * FLOATS_PER_PARTICLE;
    s[o + VX] = p.velocity.x;
    s[o + VY] = p.velocity.y;
    s[o + VZ] = p.velocity.z;
    s[o + AGE] = 0;
    s[o + LIFE] = Math.max(1e-3, p.life);
    s[o + SIZE0] = p.size0;
    s[o + SIZE1] = p.size1;
    unpackColor(p.color0, s, o + R0);
    unpackColor(p.color1, s, o + R1);
    s[o + ALPHA0] = p.alpha0;
    s[o + ALPHA1] = p.alpha1;
    s[o + GRAV] = p.gravity;
    this.drag[slot] = p.drag;
    this.spin[slot] = p.spin;
    this.rot[slot] = p.rotation;
    this.frame[slot] = p.frame;
    this.pos[slot * 3] = p.position.x;
    this.pos[slot * 3 + 1] = p.position.y;
    this.pos[slot * 3 + 2] = p.position.z;
  }

  /** Advance every particle by `dt` seconds and rewrite the instance buffers. */
  update(dt: number): void {
    const pool = this.pool;
    const s = this.state;
    // Age and kill first (iterate backwards: release swaps the last live slot in).
    for (let i = pool.size - 1; i >= 0; i--) {
      const slot = pool.at(i);
      const o = slot * FLOATS_PER_PARTICLE;
      const age = (s[o + AGE] as number) + dt;
      if (age >= (s[o + LIFE] as number)) pool.release(slot);
      else s[o + AGE] = age;
    }
    const n = pool.size;
    const pos = this.pos;
    const color = this.colorAttr.array as Float32Array;
    const size = this.sizeAttr.array as Float32Array;
    const frame = this.frameAttr.array as Float32Array;
    const rot = this.rotAttr.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const slot = pool.at(i);
      const o = slot * FLOATS_PER_PARTICLE;
      const t = (s[o + AGE] as number) / (s[o + LIFE] as number);
      // Integrate.
      const damp = 1 / (1 + (this.drag[slot] as number) * dt);
      let vx = (s[o + VX] as number) * damp;
      let vy = ((s[o + VY] as number) - FX_GRAVITY * (s[o + GRAV] as number) * dt) * damp;
      let vz = (s[o + VZ] as number) * damp;
      s[o + VX] = vx;
      s[o + VY] = vy;
      s[o + VZ] = vz;
      vx *= dt;
      vy *= dt;
      vz *= dt;
      pos[slot * 3] = (pos[slot * 3] as number) + vx;
      pos[slot * 3 + 1] = (pos[slot * 3 + 1] as number) + vy;
      pos[slot * 3 + 2] = (pos[slot * 3 + 2] as number) + vz;
      this.rot[slot] = (this.rot[slot] as number) + (this.spin[slot] as number) * dt;
      this.denseWrite(i, slot, t, color, size, frame, rot);
    }
    this.mesh.geometry.instanceCount = n;
    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.frameAttr.needsUpdate = true;
    this.rotAttr.needsUpdate = true;
  }

  private denseWrite(
    i: number,
    slot: number,
    t: number,
    color: Float32Array,
    size: Float32Array,
    frame: Float32Array,
    rot: Float32Array,
  ): void {
    const s = this.state;
    const o = slot * FLOATS_PER_PARTICLE;
    const dense = this.posAttr.array as Float32Array;
    const px = this.pos[slot * 3] as number;
    const py = this.pos[slot * 3 + 1] as number;
    const pz = this.pos[slot * 3 + 2] as number;
    dense[i * 3] = px;
    dense[i * 3 + 1] = py;
    dense[i * 3 + 2] = pz;
    const u = 1 - t;
    color[i * 4] = (s[o + R0] as number) * u + (s[o + R1] as number) * t;
    color[i * 4 + 1] = (s[o + G0] as number) * u + (s[o + G1] as number) * t;
    color[i * 4 + 2] = (s[o + B0] as number) * u + (s[o + B1] as number) * t;
    color[i * 4 + 3] = (s[o + ALPHA0] as number) * u + (s[o + ALPHA1] as number) * t;
    size[i] = (s[o + SIZE0] as number) * u + (s[o + SIZE1] as number) * t;
    frame[i] = this.frame[slot] as number;
    rot[i] = this.rot[slot] as number;
  }

  /** Position of the live particle at dense index `i` (for tests). */
  positionAt(i: number, out: Vec3): Vec3 {
    const slot = this.pool.at(i);
    out.x = this.pos[slot * 3] as number;
    out.y = this.pos[slot * 3 + 1] as number;
    out.z = this.pos[slot * 3 + 2] as number;
    return out;
  }

  /** Instance attribute arrays, for tests that check nothing is reallocated. */
  buffers(): readonly ArrayBufferView[] {
    return [
      this.posAttr.array,
      this.colorAttr.array,
      this.sizeAttr.array,
      this.frameAttr.array,
      this.rotAttr.array,
    ];
  }

  clear(): void {
    this.pool.clear();
    this.mesh.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
