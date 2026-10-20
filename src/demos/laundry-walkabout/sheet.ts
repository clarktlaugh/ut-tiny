/**
 * Small DOM helpers for the walkabout's panels (P31): a modal sheet (card
 * over a backdrop, big tap targets, closes on backdrop tap or Escape, swallows
 * keys and pointers so the game never sees them) and the left toolbar that
 * opens the sheets.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface SheetOptions {
  root: HTMLElement;
  title: string;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface Sheet {
  /** The backdrop (hidden while closed). */
  readonly element: HTMLElement;
  /** Where content goes. */
  readonly body: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  dispose(): void;
}

export function createSheet(options: SheetOptions): Sheet {
  const backdrop = el('div', 'lw-backdrop');
  backdrop.hidden = true;
  const card = el('div', 'lw-sheet');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const head = el('div', 'lw-sheet-head');
  const title = el('h2', undefined, options.title);
  const done = el('button', 'lw-btn lw-primary', 'Done');
  done.type = 'button';
  head.append(title, done);
  const body = el('div', 'lw-sheet-body');
  card.append(head, body);
  backdrop.append(card);
  options.root.append(backdrop);

  let lastFocus: Element | null = null;
  const sheet: Sheet = {
    element: backdrop,
    body,
    get isOpen() {
      return !backdrop.hidden;
    },
    open() {
      if (!backdrop.hidden) return;
      lastFocus = document.activeElement;
      if (document.pointerLockElement) document.exitPointerLock();
      backdrop.hidden = false;
      done.focus({ preventScroll: true });
      options.onOpen?.();
    },
    close() {
      if (backdrop.hidden) return;
      backdrop.hidden = true;
      if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
      options.onClose?.();
    },
    dispose() {
      backdrop.remove();
    },
  };

  done.addEventListener('click', sheet.close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) sheet.close();
  });
  // Keys and pointers inside the sheet are the sheet's; the game must not jump or fire.
  backdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') sheet.close();
  });
  for (const type of ['keyup', 'pointerdown', 'mousedown', 'touchstart'] as const) {
    backdrop.addEventListener(type, (e) => e.stopPropagation());
  }
  return sheet;
}

export interface Toolbar {
  readonly element: HTMLElement;
  button(label: string, title: string, onClick: () => void): HTMLButtonElement;
  dispose(): void;
}

/** The left toolbar (the shell's own toolbar sits on the right). */
export function createToolbar(root: HTMLElement): Toolbar {
  const bar = el('div', 'lw-bar');
  for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) {
    bar.addEventListener(type, (e) => e.stopPropagation());
  }
  root.append(bar);
  return {
    element: bar,
    button(label, title, onClick) {
      const b = el('button', 'lw-btn', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', onClick);
      bar.append(b);
      return b;
    },
    dispose: () => bar.remove(),
  };
}
