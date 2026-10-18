/**
 * AudioContext resume (docs/DESIGN.md §15: browsers start audio suspended
 * until a user gesture).
 *
 * The menu's Play button should call `resumeAudio` directly. As a safety net,
 * `resumeOnGesture` listens for the first pointer, key or touch gesture on a
 * target (usually `window`) and resumes then, detaching itself once the
 * context is running.
 */

export interface ResumableContext {
  readonly state: string;
  resume(): Promise<void>;
}

/** Gestures that browsers accept as user activation for audio. */
export const RESUME_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchend'] as const;

/** Capture phase, so handlers that stop propagation cannot hide the gesture. */
const LISTEN: AddEventListenerOptions = { capture: true };

/** Resume now. Resolves true if the context is running afterwards. Never rejects. */
export async function resumeAudio(ctx: ResumableContext): Promise<boolean> {
  if (ctx.state === 'running') return true;
  if (ctx.state === 'closed') return false;
  try {
    await ctx.resume();
  } catch {
    return false;
  }
  return ctx.state === 'running';
}

/**
 * Resume `ctx` on the next user gesture on `target`. Returns a function that
 * detaches the listeners early. `onResumed` runs once, when the context is
 * running (immediately if it already is).
 */
export function resumeOnGesture(
  target: EventTarget,
  ctx: ResumableContext,
  onResumed?: () => void,
): () => void {
  let attached = false;
  let done = false;
  const detach = (): void => {
    if (!attached) return;
    attached = false;
    for (const type of RESUME_EVENTS) target.removeEventListener(type, handler, LISTEN);
  };
  const finish = (): void => {
    if (done) return;
    done = true;
    detach();
    onResumed?.();
  };
  const handler = (): void => {
    void resumeAudio(ctx).then((running) => {
      if (running) finish();
    });
  };

  if (ctx.state === 'running') {
    finish();
    return detach;
  }
  for (const type of RESUME_EVENTS) target.addEventListener(type, handler, LISTEN);
  attached = true;
  return detach;
}
