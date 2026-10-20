/**
 * The Go-to panel (P31): every `Place` as a tap target, grouped into views
 * (the map's named cameras), the §7.1 routes and the hazards, each with its
 * one-line hint. Picking a place closes the sheet and hands it to `onPick`.
 */
import { groupLabel, type Place, type PlaceGroup } from './places';
import { createSheet, el, type Sheet } from './sheet';

export interface TeleportSheetOptions {
  root: HTMLElement;
  places: readonly Place[];
  onPick: (place: Place) => void;
}

export interface TeleportSheet {
  readonly sheet: Sheet;
  /** Highlight the place the pawn was last sent to. */
  setCurrent(place: Place | null): void;
  dispose(): void;
}

const GROUP_ORDER: readonly PlaceGroup[] = ['camera', 'route', 'hazard'];

export function mountTeleportSheet(options: TeleportSheetOptions): TeleportSheet {
  const sheet = createSheet({ root: options.root, title: 'Go to' });
  sheet.element.classList.add('lw-goto');
  const buttons = new Map<string, HTMLButtonElement>();
  sheet.body.append(
    el(
      'p',
      'lw-summary',
      'Teleport to a view or to the start of a route, then try it. Tap a hazard to see it bite; you respawn.',
    ),
  );
  for (const group of GROUP_ORDER) {
    const places = options.places.filter((p) => p.group === group);
    if (places.length === 0) continue;
    sheet.body.append(el('h3', 'lw-group', groupLabel(group)));
    const list = el('div', 'lw-places');
    for (const place of places) {
      const b = el('button', 'lw-place');
      b.type = 'button';
      b.dataset.place = place.id;
      b.append(el('span', 'lw-place-label', place.label), el('span', 'lw-place-hint', place.hint));
      b.addEventListener('click', () => {
        options.onPick(place);
        sheet.close();
      });
      list.append(b);
      buttons.set(place.id, b);
    }
    sheet.body.append(list);
  }
  return {
    sheet,
    setCurrent(place) {
      for (const [id, b] of buttons) b.classList.toggle('lw-on', place?.id === id);
    },
    dispose: () => sheet.dispose(),
  };
}
