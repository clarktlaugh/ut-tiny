/** Frame-time statistics and numbers for the performance overlay and Copy feedback. */

export interface FrameSummary {
  readonly fps: number;
  readonly avgMs: number;
  readonly worstMs: number;
  readonly frames: number;
}

/** Rolling window of frame times (ms), summarised over the last `windowMs`. */
export class FrameStats {
  private readonly times: number[] = [];
  private readonly deltas: number[] = [];
  /** Longer history for the frame-time graph. */
  private readonly history: number[] = [];
  private last: number | null = null;

  constructor(
    private readonly windowMs = 1000,
    private readonly historyLength = 180,
  ) {}

  sample(now: number): void {
    if (this.last !== null) {
      const dt = now - this.last;
      this.times.push(now);
      this.deltas.push(dt);
      this.history.push(dt);
      if (this.history.length > this.historyLength) this.history.shift();
    }
    this.last = now;
    while (this.times.length && now - this.times[0]! > this.windowMs) {
      this.times.shift();
      this.deltas.shift();
    }
  }

  /** Drop the window and the gap since the last frame (after the tab was hidden). */
  reset(): void {
    this.times.length = 0;
    this.deltas.length = 0;
    this.last = null;
  }

  /** Recent frame times, oldest first, for the graph. */
  recent(): readonly number[] {
    return this.history;
  }

  summary(): FrameSummary {
    const n = this.deltas.length;
    if (!n) return { fps: 0, avgMs: 0, worstMs: 0, frames: 0 };
    let sum = 0;
    let worst = 0;
    for (const d of this.deltas) {
      sum += d;
      worst = Math.max(worst, d);
    }
    const avgMs = sum / n;
    return { fps: 1000 / avgMs, avgMs, worstMs: worst, frames: n };
  }
}

/** The parts of `THREE.WebGLRenderer.info` the overlay reads. */
export interface RendererInfoLike {
  readonly render: { readonly calls: number; readonly triangles: number };
  readonly memory: { readonly geometries: number; readonly textures: number };
}

export interface PerfSnapshot {
  readonly frames: FrameSummary;
  readonly devicePixelRatio: number;
  /** Pixel ratio handed to the renderer. */
  readonly pixelRatio: number;
  /** Quality preset's render scale. */
  readonly renderScale: number;
  readonly quality: string;
  readonly renderer?: RendererInfoLike;
  /** Used JS heap in bytes, where the browser exposes it (Chromium). */
  readonly heapBytes?: number;
  /** Demo-specific extras (particles, beams, ...). */
  readonly extra?: Readonly<Record<string, string | number>>;
}

/** Labelled numbers, in display order; shared by the overlay and Copy feedback. */
export function perfNumbers(s: PerfSnapshot): Record<string, string> {
  const f = s.frames;
  const out: Record<string, string> = {
    fps: f.fps.toFixed(0),
    'frame ms': `avg ${f.avgMs.toFixed(1)}, worst ${f.worstMs.toFixed(1)}`,
  };
  if (s.renderer) {
    out['draw calls'] = String(s.renderer.render.calls);
    out.triangles = String(s.renderer.render.triangles);
    out.geometries = String(s.renderer.memory.geometries);
    out.textures = String(s.renderer.memory.textures);
  }
  if (s.heapBytes !== undefined && Number.isFinite(s.heapBytes)) {
    out['JS heap'] = `${(s.heapBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  out.dpr = String(s.devicePixelRatio);
  out['render scale'] = `${s.renderScale} (pixel ratio ${s.pixelRatio.toFixed(2)}, ${s.quality})`;
  for (const [key, value] of Object.entries(s.extra ?? {})) out[key] = String(value);
  return out;
}

/** Used JS heap in bytes (Chromium's non-standard `performance.memory`), if available. */
export function usedHeapBytes(perf: Performance): number | undefined {
  const memory = (perf as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : undefined;
}

/** Draw frame times as bars: 0–50 ms tall, guide lines at 60 and 30 fps. */
export function drawFrameGraph(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frameMs: readonly number[],
): void {
  const maxMs = 50;
  ctx.clearRect(0, 0, width, height);
  const bar = width / Math.max(1, frameMs.length);
  const start = Math.max(0, frameMs.length - Math.floor(width / Math.max(bar, 1)));
  for (let i = start; i < frameMs.length; i++) {
    const ms = frameMs[i]!;
    const h = Math.min(1, ms / maxMs) * height;
    ctx.fillStyle = ms > 33.4 ? '#e5534b' : ms > 16.8 ? '#d9a441' : '#6cc28a';
    ctx.fillRect((i - start) * bar, height - h, Math.max(1, bar - 0.5), h);
  }
  ctx.fillStyle = 'rgb(255 255 255 / 35%)';
  for (const ms of [1000 / 60, 1000 / 30]) {
    ctx.fillRect(0, Math.round(height - (ms / maxMs) * height), width, 1);
  }
}
