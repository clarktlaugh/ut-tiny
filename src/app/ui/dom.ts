/**
 * The slice of the DOM the menus touch (docs/DESIGN.md §11). Real `Document`
 * and `HTMLElement` satisfy it; tests pass a tiny fake, so no DOM library is needed.
 */
export interface UiNode {
  className: string;
  textContent: string | null;
  hidden: boolean;
  disabled: boolean;
  checked: boolean;
  value: string;
  type: string;
  appendChild(child: UiNode): unknown;
  replaceChildren(...children: UiNode[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
}

export interface UiDocument {
  createElement(tag: string): UiNode;
}
