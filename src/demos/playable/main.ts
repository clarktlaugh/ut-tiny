/**
 * The stopgap playable laundry-room demo from PR #59 (`src/app/demo/`), built
 * as `/demos/playable.html`. It brings its own renderer quality, touch
 * controls, HUD and overlay; the shell adds the toolbar, card and feedback.
 * The real match flow replaces it later.
 */
import { startPlayableDemo } from '../../app/demo/playableDemo';
import { createDemoShell } from '../shell';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('playable.html is missing #game');

declare global {
  interface Window {
    /** The running demo, for the console and headless checks. */
    __demo?: Awaited<ReturnType<typeof startPlayableDemo>>;
  }
}

createDemoShell({ slug: 'playable' });

startPlayableDemo({ canvas, root: document.body })
  .then((demo) => {
    window.__demo = demo;
    document.body.dataset.ready = '1';
  })
  .catch((err: unknown) => {
    console.error(err);
    const pre = document.createElement('pre');
    pre.style.cssText =
      'position:fixed;inset:16px;color:#f88;font:14px monospace;white-space:pre-wrap';
    pre.textContent = `Failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    document.body.append(pre);
  });
