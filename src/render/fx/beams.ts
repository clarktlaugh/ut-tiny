/**
 * Pooled beam ribbons (docs/DESIGN.md §8.3): the lingering Super Shock beam,
 * sniper and assault-rifle tracers.
 *
 * All beams share one geometry and one draw call. Each beam is two
 * camera-facing quads (a wide soft halo and a narrow bright core) whose side
 * vectors are recomputed every frame from the camera position. A `tracer`
 * beam is a short bright segment that travels from `from` toward `to`; a
 * `linger` beam spans the whole ray and fades out over its life.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Mesh,
  ShaderMaterial,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import type { Vec3 } from '../../sim/types';
import { AllocationCounter, SlotPool } from './pool';
import { unpackColor } from './particles';

export type BeamKind = 'linger' | 'tracer';

export interface BeamSpawn {
  kind: BeamKind;
  from: Vec3;
  to: Vec3;
  /** Halo width in meters; the core is a third of it. */
  width: number;
  /** Halo color (0xRRGGBB); the core is white-ish. */
  color: number;
  /** Core color. */
  coreColor: number;
  /** Lifetime for `linger` beams; ignored for tracers (they die on arrival). */
  life: number;
  /** Tracer travel speed, m/s, and visible segment length, m. */
  speed: number;
  segment: number;
}

const QUADS_PER_BEAM = 2;
const VERTS_PER_BEAM = QUADS_PER_BEAM * 4;
const FLOATS = 14;
const FX = 0;
const FY = 1;
const FZ = 2;
const DX = 3;
const DY = 4;
const DZ = 5;
const LEN = 6;
const AGE = 7;
const LIFE = 8;
const WIDTH = 9;
const SPEED = 10;
const SEG = 11;
const KIND = 12; // 0 linger, 1 tracer

const VERTEX = /* glsl */ `
attribute vec4 aColor;
varying vec4 vColor;
varying vec2 vUv;
void main() {
  vColor = aColor;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
varying vec4 vColor;
varying vec2 vUv;
void main() {
  float across = abs(vUv.y * 2.0 - 1.0);
  float soft = 1.0 - across * across;
  // Fade the ends of the strip so tracers read as streaks.
  float ends = smoothstep(0.0, 0.15, vUv.x) * smoothstep(0.0, 0.15, 1.0 - vUv.x);
  float a = vColor.a * soft * soft * ends;
  gl_FragColor = vec4(vColor.rgb * a, a);
  if (a < 0.002) discard;
}
`;

const vFrom = new Vector3();
const vTo = new Vector3();
const vDir = new Vector3();
const vSide = new Vector3();
const vMid = new Vector3();
const vEye = new Vector3();

export class BeamPool {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  readonly pool: SlotPool;
  readonly allocations = new AllocationCounter();
  private readonly state: Float32Array;
  private readonly color: Float32Array; // per beam: halo rgb, core rgb
  private readonly positions: Float32BufferAttribute;
  private readonly colors: Float32BufferAttribute;

  constructor(readonly capacity: number) {
    const a = this.allocations;
    this.pool = a.track(new SlotPool(capacity));
    this.state = a.track(new Float32Array(capacity * FLOATS));
    this.color = a.track(new Float32Array(capacity * 6));
    const geometry = a.track(new BufferGeometry());
    this.positions = a.track(new Float32BufferAttribute(capacity * VERTS_PER_BEAM * 3, 3));
    this.positions.setUsage(DynamicDrawUsage);
    this.colors = a.track(new Float32BufferAttribute(capacity * VERTS_PER_BEAM * 4, 4));
    this.colors.setUsage(DynamicDrawUsage);
    const uv = new Float32Array(capacity * VERTS_PER_BEAM * 2);
    const index = new Uint16Array(capacity * QUADS_PER_BEAM * 6);
    for (let q = 0; q < capacity * QUADS_PER_BEAM; q++) {
      const v = q * 4;
      // Corners: 0 = from/left, 1 = from/right, 2 = to/right, 3 = to/left.
      uv.set([0, 0, 0, 1, 1, 1, 1, 0], v * 2);
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
    }
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('aColor', this.colors);
    geometry.setAttribute('uv', a.track(new Float32BufferAttribute(uv, 2)));
    geometry.setIndex(a.track(new Uint16BufferAttribute(index, 1)));
    geometry.setDrawRange(0, 0);
    const material = a.track(
      new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        // The strip's winding depends on which side of the ray the camera is.
        side: DoubleSide,
      }),
    );
    this.mesh = a.track(new Mesh(geometry, material));
    this.mesh.name = 'fx-beams';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
  }

  get size(): number {
    return this.pool.size;
  }

  emit(b: Readonly<BeamSpawn>): void {
    const slot = this.pool.acquire();
    const s = this.state;
    const o = slot * FLOATS;
    const dx = b.to.x - b.from.x;
    const dy = b.to.y - b.from.y;
    const dz = b.to.z - b.from.z;
    const len = Math.hypot(dx, dy, dz);
    const inv = len > 1e-6 ? 1 / len : 0;
    s[o + FX] = b.from.x;
    s[o + FY] = b.from.y;
    s[o + FZ] = b.from.z;
    s[o + DX] = dx * inv;
    s[o + DY] = dy * inv;
    s[o + DZ] = dz * inv;
    s[o + LEN] = len;
    s[o + AGE] = 0;
    s[o + LIFE] = Math.max(1e-3, b.life);
    s[o + WIDTH] = b.width;
    s[o + SPEED] = Math.max(1e-3, b.speed);
    s[o + SEG] = Math.max(1e-3, b.segment);
    s[o + KIND] = b.kind === 'tracer' ? 1 : 0;
    unpackColor(b.color, this.color, slot * 6);
    unpackColor(b.coreColor, this.color, slot * 6 + 3);
  }

  /** Head and tail of a beam along its ray at its current age, as distances from `from`. */
  private span(o: number): [number, number] {
    const s = this.state;
    const len = s[o + LEN] as number;
    if ((s[o + KIND] as number) === 0) return [0, len];
    const head = Math.min(len, (s[o + SPEED] as number) * (s[o + AGE] as number));
    const tail = Math.max(0, head - (s[o + SEG] as number));
    return [tail, head];
  }

  /** Age beams by `dt` and rebuild the camera-facing strips for `eye`. */
  update(dt: number, eye: Readonly<Vec3>): void {
    const pool = this.pool;
    const s = this.state;
    for (let i = pool.size - 1; i >= 0; i--) {
      const slot = pool.at(i);
      const o = slot * FLOATS;
      const age = (s[o + AGE] as number) + dt;
      s[o + AGE] = age;
      const tracer = (s[o + KIND] as number) === 1;
      const dead = tracer
        ? (s[o + SPEED] as number) * age - (s[o + SEG] as number) >= (s[o + LEN] as number)
        : age >= (s[o + LIFE] as number);
      if (dead) pool.release(slot);
    }
    vEye.set(eye.x, eye.y, eye.z);
    const pos = this.positions.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const n = pool.size;
    for (let i = 0; i < n; i++) {
      const slot = pool.at(i);
      const o = slot * FLOATS;
      const [tail, head] = this.span(o);
      vDir.set(s[o + DX] as number, s[o + DY] as number, s[o + DZ] as number);
      vFrom.set(s[o + FX] as number, s[o + FY] as number, s[o + FZ] as number);
      vTo.copy(vFrom).addScaledVector(vDir, head);
      vFrom.addScaledVector(vDir, tail);
      vMid.copy(vFrom).add(vTo).multiplyScalar(0.5).sub(vEye);
      vSide.crossVectors(vDir, vMid);
      if (vSide.lengthSq() < 1e-8) vSide.set(0, 1, 0).cross(vDir);
      if (vSide.lengthSq() < 1e-8) vSide.set(1, 0, 0);
      vSide.normalize();
      const tracer = (s[o + KIND] as number) === 1;
      const fade = tracer ? 1 : 1 - (s[o + AGE] as number) / (s[o + LIFE] as number);
      const width = s[o + WIDTH] as number;
      const c = slot * 6;
      this.writeQuad(pos, col, i * 2, width * 0.5, fade * 0.6, c);
      this.writeQuad(pos, col, i * 2 + 1, width * 0.16, fade, c + 3);
    }
    this.mesh.geometry.setDrawRange(0, n * QUADS_PER_BEAM * 6);
    this.positions.needsUpdate = true;
    this.colors.needsUpdate = true;
  }

  private writeQuad(
    pos: Float32Array,
    col: Float32Array,
    quad: number,
    halfWidth: number,
    alpha: number,
    colorOffset: number,
  ): void {
    const v = quad * 4;
    const sx = vSide.x * halfWidth;
    const sy = vSide.y * halfWidth;
    const sz = vSide.z * halfWidth;
    const write = (k: number, p: Vector3, sign: number): void => {
      const j = (v + k) * 3;
      pos[j] = p.x + sx * sign;
      pos[j + 1] = p.y + sy * sign;
      pos[j + 2] = p.z + sz * sign;
      const cj = (v + k) * 4;
      col[cj] = this.color[colorOffset] as number;
      col[cj + 1] = this.color[colorOffset + 1] as number;
      col[cj + 2] = this.color[colorOffset + 2] as number;
      col[cj + 3] = alpha;
    };
    write(0, vFrom, -1);
    write(1, vFrom, 1);
    write(2, vTo, 1);
    write(3, vTo, -1);
  }

  /** Current [tail, head] distances of the live beam at dense index `i` (for tests). */
  spanAt(i: number): [number, number] {
    return this.span(this.pool.at(i) * FLOATS);
  }

  buffers(): readonly ArrayBufferView[] {
    return [this.positions.array, this.colors.array];
  }

  clear(): void {
    this.pool.clear();
    this.mesh.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
