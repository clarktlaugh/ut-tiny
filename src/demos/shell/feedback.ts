/** Text for the shell's Copy feedback button, ready to paste into a PR comment. */

export interface FeedbackInfo {
  readonly slug: string;
  readonly title: string;
  readonly commit: string;
  readonly url: string;
  readonly userAgent: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly devicePixelRatio: number;
  readonly touch: boolean;
  readonly quality: string;
  readonly fps: number;
  /** Demo-specific values (tuning sliders, toggles); omitted when empty. */
  readonly tuning?: Readonly<Record<string, unknown>>;
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

export function formatFeedback(info: FeedbackInfo): string {
  const lines = [
    `**Demo feedback: ${info.title}** (\`${info.slug}\`)`,
    '',
    `- Commit: \`${info.commit}\``,
    `- URL: ${info.url}`,
    `- Device: ${info.touch ? 'touch' : 'desktop'}, ${info.viewport.width}×${info.viewport.height} @${info.devicePixelRatio}x, quality ${info.quality}`,
    `- FPS: ${Math.round(info.fps)}`,
    `- Browser: ${info.userAgent}`,
  ];
  const tuning = Object.entries(info.tuning ?? {});
  if (tuning.length) {
    lines.push('- Tuning:');
    for (const [key, value] of tuning) lines.push(`  - ${key}: ${formatValue(value)}`);
  }
  lines.push('', 'Notes: ');
  return lines.join('\n');
}

/** Exponential moving average of frames per second from frame deltas in ms. */
export class FpsMeter {
  fps = 60;
  private last: number | null = null;

  /** Feed a `requestAnimationFrame` timestamp; returns the smoothed FPS. */
  sample(now: number): number {
    if (this.last !== null) {
      const dt = Math.min(1000, Math.max(1, now - this.last));
      this.fps += (1000 / dt - this.fps) * 0.1;
    }
    this.last = now;
    return this.fps;
  }

  /** Forget the last timestamp (after the tab was hidden) so the gap is not counted. */
  reset(): void {
    this.last = null;
  }
}
