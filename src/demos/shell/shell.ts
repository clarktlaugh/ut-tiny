/**
 * Shared demo shell (docs/DESIGN.md §18.8). Every hub demo calls
 * `createDemoShell({ slug })` first; the shell adds a toolbar (back to the hub,
 * What-to-check, Copy feedback, Reset), an FPS readout, the commit stamp, the
 * What-to-check card (shown on load, reopenable), picks the render quality
 * (low on touch devices) and owns a layer where an input overlay (touch
 * controls, P27) can mount.
 *
 * Query parameters handled here: `card=0` skips the card on load,
 * `quality=low|high` overrides the automatic quality.
 */
import { findDemo, type DemoEntry } from '../registry';
import { FpsMeter, formatFeedback } from './feedback';
import { chooseQuality, pixelRatioFor, type Quality } from './quality';
import './shell.css';

/** Touch controls or any other input layer a demo can mount (P27 fills this). */
export interface InputOverlay {
  /** Called once with the shell's overlay layer (full screen, pointer events off by default). */
  mount(root: HTMLElement, shell: DemoShell): void;
  unmount(): void;
}

export interface DemoShellOptions {
  slug: string;
  /** Show the What-to-check card on load (default true; `?card=0` also turns it off). */
  showCardOnLoad?: boolean;
  /** Reset button handler; the default reloads the page. */
  onReset?: () => void;
  /** Demo-specific values included in Copy feedback. */
  tuning?: () => Readonly<Record<string, unknown>>;
}

export interface DemoShell {
  readonly demo: DemoEntry;
  readonly commit: string;
  /** Primary pointer is coarse (phone or tablet). */
  readonly touch: boolean;
  readonly quality: Quality;
  /** Pixel ratio for `renderer.setPixelRatio`, from the quality preset. */
  pixelRatio(): number;
  /** Smoothed frames per second of the page. */
  readonly fps: number;
  /** Full-screen layer above the demo for input overlays. */
  readonly overlayRoot: HTMLElement;
  setInputOverlay(overlay: InputOverlay | null): void;
  openCard(): void;
  closeCard(): void;
  feedbackText(): string;
  copyFeedback(): Promise<boolean>;
}

const HUB_URL = './';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortSha(sha: string): string {
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : sha;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback.
  }
  const area = el('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function createDemoShell(options: DemoShellOptions): DemoShell {
  const demo = findDemo(options.slug);
  if (!demo) throw new Error(`demo "${options.slug}" is not in src/demos/registry.ts`);
  const params = new URLSearchParams(location.search);
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const quality = chooseQuality({ touch, override: params.get('quality') });
  const commit = __DEMO_COMMIT__;
  const meter = new FpsMeter();

  document.documentElement.classList.add('demo-shell');
  document.documentElement.classList.toggle('demo-touch', touch);
  document.documentElement.dataset.quality = quality.level;

  // --- Overlay layer --------------------------------------------------------
  const overlayRoot = el('div', 'ds-overlay');
  let overlay: InputOverlay | null = null;

  // --- Toolbar ----------------------------------------------------------------
  const bar = el('div', 'ds-bar');
  const back = el('a', 'ds-btn', '‹ Demos');
  back.href = HUB_URL;
  back.title = 'All demos';
  const helpBtn = el('button', 'ds-btn', '?');
  helpBtn.type = 'button';
  helpBtn.title = 'What to check';
  helpBtn.setAttribute('aria-label', 'What to check');
  const copyBtn = el('button', 'ds-btn', 'Copy feedback');
  copyBtn.type = 'button';
  const resetBtn = el('button', 'ds-btn', 'Reset');
  resetBtn.type = 'button';
  const stamp = el('span', 'ds-stamp');
  const fpsText = el('span', 'ds-fps', '-- fps');
  const shaText = el('span', 'ds-sha', shortSha(commit));
  shaText.title = `commit ${commit}`;
  stamp.append(fpsText, shaText);
  bar.append(back, helpBtn, copyBtn, resetBtn, stamp);

  // --- What-to-check card -----------------------------------------------------
  const backdrop = el('div', 'ds-backdrop');
  backdrop.hidden = true;
  const card = el('div', 'ds-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'ds-card-title');
  const head = el('div', 'ds-card-head');
  const title = el('h2', undefined, demo.title);
  title.id = 'ds-card-title';
  head.append(title, el('span', 'ds-tag', `${demo.milestone} · ${demo.packet}`));
  const lead = el('p', 'ds-lead', 'What to check');
  const list = el('ol');
  for (const item of demo.checklist) list.append(el('li', undefined, item));
  const foot = el('div', 'ds-card-foot');
  const meta = el('span', 'ds-meta', `${quality.level} quality · ${shortSha(commit)}`);
  const close = el('button', 'ds-btn ds-primary', 'Got it');
  close.type = 'button';
  foot.append(meta, close);
  // Manual copy area, shown only when the clipboard is unavailable.
  const manual = el('textarea', 'ds-manual');
  manual.readOnly = true;
  manual.hidden = true;
  card.append(head, lead, list, manual, foot);
  backdrop.append(card);

  const toast = el('div', 'ds-toast');
  toast.hidden = true;
  let toastTimer = 0;
  function showToast(text: string): void {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 1800);
  }

  document.body.append(overlayRoot, bar, backdrop, toast);

  let lastFocus: Element | null = null;
  function openCard(): void {
    lastFocus = document.activeElement;
    if (document.pointerLockElement) document.exitPointerLock();
    backdrop.hidden = false;
    close.focus({ preventScroll: true });
  }
  function closeCard(): void {
    backdrop.hidden = true;
    manual.hidden = true;
    lead.hidden = false;
    list.hidden = false;
    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
  }

  const shell: DemoShell = {
    demo,
    commit,
    touch,
    quality,
    pixelRatio: () => pixelRatioFor(quality, window.devicePixelRatio),
    get fps() {
      return meter.fps;
    },
    overlayRoot,
    setInputOverlay(next) {
      overlay?.unmount();
      overlay = next;
      overlay?.mount(overlayRoot, shell);
    },
    openCard,
    closeCard,
    feedbackText: () =>
      formatFeedback({
        slug: demo.slug,
        title: demo.title,
        commit,
        url: location.href,
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        touch,
        quality: quality.level,
        fps: meter.fps,
        tuning: options.tuning?.(),
      }),
    async copyFeedback() {
      const text = shell.feedbackText();
      const ok = await writeClipboard(text);
      if (ok) {
        showToast('Feedback copied. Paste it into a PR comment.');
      } else {
        // Let the reviewer copy by hand.
        openCard();
        lead.hidden = true;
        list.hidden = true;
        manual.hidden = false;
        manual.value = text;
        manual.select();
      }
      return ok;
    },
  };

  helpBtn.addEventListener('click', openCard);
  close.addEventListener('click', closeCard);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeCard();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !backdrop.hidden) closeCard();
  });
  copyBtn.addEventListener('click', () => void shell.copyFeedback());
  resetBtn.addEventListener('click', () => {
    if (options.onReset) {
      options.onReset();
      showToast('Reset');
    } else {
      location.reload();
    }
  });
  // Keep shell clicks away from demo handlers (pointer lock, look drags).
  for (const node of [bar, backdrop]) {
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  let lastText = 0;
  const tick = (now: number): void => {
    meter.sample(now);
    if (now - lastText > 250) {
      fpsText.textContent = `${Math.round(meter.fps)} fps`;
      lastText = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  document.addEventListener('visibilitychange', () => meter.reset());

  if ((options.showCardOnLoad ?? true) && params.get('card') !== '0') openCard();
  return shell;
}
