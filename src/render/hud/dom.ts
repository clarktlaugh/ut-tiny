/**
 * The slice of the DOM the HUD touches (docs/DESIGN.md §11). Real `Document`
 * and `HTMLElement` satisfy it; tests pass a tiny fake, so no DOM library is needed.
 */
export interface HudNode {
  className: string;
  textContent: string | null;
  hidden: boolean | string;
  style: { setProperty(name: string, value: string): void };
  appendChild(child: HudNode): unknown;
  replaceChildren(...children: HudNode[]): void;
  setAttribute(name: string, value: string): void;
}

export interface HudDocument {
  createElement(tag: string): HudNode;
}
