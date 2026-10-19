import { startPlayableDemo } from './app/demo/playableDemo';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('missing #game canvas');

declare global {
  interface Window {
    /** The running demo, for the console and headless checks. */
    __demo?: Awaited<ReturnType<typeof startPlayableDemo>>;
  }
}

startPlayableDemo({ canvas, root: document.body })
  .then((demo) => {
    window.__demo = demo;
  })
  .catch((err: unknown) => {
    console.error(err);
    const pre = document.createElement('pre');
    pre.style.cssText =
      'position:fixed;inset:16px;color:#f88;font:14px monospace;white-space:pre-wrap';
    pre.textContent = `Failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    document.body.append(pre);
  });
