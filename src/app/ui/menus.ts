/**
 * Menus (docs/DESIGN.md §11): main menu, match setup, settings, loading and
 * the end-of-match scoreboard. Driven by `MatchFlow`: the visible screen
 * follows `flow.state`, and the buttons call the flow (`openSetup`, `start`,
 * `rematch`, `toMenu`). Settings edit the shared `SettingsStore` live.
 *
 * Per rendered frame while the end screen can show: `menus.update()`.
 * The countdown, playing and loading-free states hide the menus entirely.
 */
import { QUALITY_PRESETS, SETTING_RANGES, type SettingsStore } from '../settings';
import { END_SCREEN_SECONDS, sanitizeSetup, type MatchFlow, type MatchSetup } from '../matchFlow';
import type { UiDocument, UiNode } from './dom';
import {
  DEFAULT_MAPS,
  SCORE_HEADERS,
  limitLabel,
  scoreRowCells,
  setupFromSettings,
  settingsFromSetup,
  skillName,
  type MapOption,
} from './model';

export interface MenuOptions {
  flow: MatchFlow;
  settings: SettingsStore;
  maps?: readonly MapOption[];
  /** Player whose row is highlighted on the scoreboard. */
  localPlayer?: string;
}

type Screen = 'main' | 'setup' | 'settings' | 'loading' | 'ended' | 'none';

export class MenuUi {
  private readonly doc: UiDocument;
  private readonly flow: MatchFlow;
  private readonly store: SettingsStore;
  private readonly maps: readonly MapOption[];
  private readonly localPlayer: string | undefined;
  private form: MatchSetup;
  private settingsOpen = false;
  private shown: Screen = 'none';
  private timer: UiNode | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    readonly root: UiNode,
    doc: UiDocument,
    opts: MenuOptions,
  ) {
    this.doc = doc;
    this.flow = opts.flow;
    this.store = opts.settings;
    this.maps = opts.maps ?? DEFAULT_MAPS;
    this.localPlayer = opts.localPlayer;
    this.form = setupFromSettings(this.store.get(), this.maps[0]?.key ?? 'laundry-room');
    root.className = 'menu';
    this.unsubscribe = this.flow.onChange(() => this.render());
    this.render();
  }

  /** Which screen is showing (for tests and the app shell). */
  get screen(): Screen {
    return this.shown;
  }

  /** Per frame: refresh the end-screen countdown text. */
  update(): void {
    if (this.shown === 'ended' && this.timer) {
      this.timer.textContent = `Back to the menu in ${Math.ceil(this.flow.endScreenRemaining)} s`;
    }
  }

  openSettings(): void {
    if (this.flow.state !== 'menu') return;
    this.settingsOpen = true;
    this.render();
  }

  closeSettings(): void {
    this.settingsOpen = false;
    this.render();
  }

  dispose(): void {
    this.unsubscribe();
  }

  private currentScreen(): Screen {
    switch (this.flow.state) {
      case 'menu':
        return this.settingsOpen ? 'settings' : 'main';
      case 'setup':
        return 'setup';
      case 'loading':
        return 'loading';
      case 'ended':
        return 'ended';
      default:
        return 'none';
    }
  }

  private render(): void {
    if (this.flow.state !== 'menu') this.settingsOpen = false;
    this.shown = this.currentScreen();
    this.timer = null;
    this.root.hidden = this.shown === 'none';
    switch (this.shown) {
      case 'main':
        return this.root.replaceChildren(this.mainScreen());
      case 'setup':
        this.form = setupFromSettings(this.store.get(), this.form.map);
        return this.root.replaceChildren(this.setupScreen());
      case 'settings':
        return this.root.replaceChildren(this.settingsScreen());
      case 'loading':
        return this.root.replaceChildren(this.loadingScreen());
      case 'ended':
        return this.root.replaceChildren(this.endedScreen());
      case 'none':
        return this.root.replaceChildren();
    }
  }

  // ---- screens ----

  private mainScreen(): UiNode {
    const panel = this.panel();
    panel.appendChild(this.text('h1', 'UT Tiny'));
    panel.appendChild(this.text('div', 'Arena deathmatch, toy-sized.', 'sub'));
    panel.appendChild(this.button('Play', () => this.flow.start(this.setupNow()), 'play'));
    panel.appendChild(this.button('Match setup', () => this.flow.openSetup(), 'setup', true));
    panel.appendChild(this.button('Settings', () => this.openSettings(), 'settings', true));
    return panel;
  }

  private setupNow(): MatchSetup {
    return setupFromSettings(this.store.get(), this.form.map);
  }

  private setupScreen(): UiNode {
    const panel = this.panel();
    panel.appendChild(this.text('h2', 'Match setup'));
    const edit = (patch: Partial<MatchSetup>): void => {
      this.form = sanitizeSetup({ ...this.form, ...patch });
    };
    panel.appendChild(
      this.select(
        'Map',
        this.maps.map((m) => ({ value: m.key, label: m.name })),
        this.form.map,
        (v) => edit({ map: v }),
        'map',
      ),
    );
    panel.appendChild(
      this.slider('Bots', 0, 15, 1, this.form.bots, (v) => edit({ bots: v }), String, 'bots'),
    );
    panel.appendChild(
      this.slider(
        'Skill',
        0,
        7,
        1,
        this.form.botSkill,
        (v) => edit({ botSkill: v }),
        skillName,
        'skill',
      ),
    );
    panel.appendChild(
      this.slider(
        'Frag limit',
        0,
        100,
        5,
        this.form.fragLimit,
        (v) => edit({ fragLimit: v }),
        (v) => limitLabel(v, 'frags'),
        'frags',
      ),
    );
    panel.appendChild(
      this.slider(
        'Time limit',
        0,
        30,
        1,
        Math.round(this.form.timeLimit / 60),
        (v) => edit({ timeLimit: v * 60 }),
        (v) => limitLabel(v, 'min'),
        'time',
      ),
    );
    const actions = this.div('actions');
    actions.appendChild(this.button('Back', () => this.flow.toMenu(), 'back', true));
    actions.appendChild(
      this.button(
        'Start match',
        () => {
          this.store.update(settingsFromSetup(this.form));
          this.flow.start(this.form);
        },
        'start',
      ),
    );
    panel.appendChild(actions);
    return panel;
  }

  private settingsScreen(): UiNode {
    const panel = this.panel();
    const s = this.store.get();
    const r = SETTING_RANGES;
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    panel.appendChild(this.text('h2', 'Settings'));
    panel.appendChild(
      this.slider(
        'Sensitivity',
        r.sensitivity.min,
        r.sensitivity.max,
        0.05,
        s.sensitivity,
        (v) => this.store.update({ sensitivity: v }),
        (v) => v.toFixed(2),
        'sensitivity',
      ),
    );
    panel.appendChild(
      this.slider(
        'Field of view',
        r.fov.min,
        r.fov.max,
        1,
        s.fov,
        (v) => this.store.update({ fov: v }),
        (v) => `${Math.round(v)}°`,
        'fov',
      ),
    );
    panel.appendChild(
      this.toggle('Invert Y', s.invertY, (v) => this.store.update({ invertY: v }), 'invertY'),
    );
    panel.appendChild(
      this.toggle(
        'Auto-switch on pickup',
        s.autoSwitchOnPickup,
        (v) => this.store.update({ autoSwitchOnPickup: v }),
        'autoSwitch',
      ),
    );
    for (const key of ['master', 'sfx', 'music', 'announcer'] as const) {
      panel.appendChild(
        this.slider(
          `${key === 'sfx' ? 'SFX' : key[0]!.toUpperCase() + key.slice(1)} volume`,
          0,
          1,
          0.05,
          s.volume[key],
          (v) => this.store.update({ volume: { [key]: v } }),
          pct,
          `volume-${key}`,
        ),
      );
    }
    panel.appendChild(
      this.select(
        'Quality',
        QUALITY_PRESETS.map((q) => ({ value: q, label: q[0]!.toUpperCase() + q.slice(1) })),
        s.quality,
        (v) => this.store.update({ quality: v as (typeof QUALITY_PRESETS)[number] }),
        'quality',
      ),
    );
    panel.appendChild(
      this.slider(
        'Render scale',
        r.renderScale.min,
        r.renderScale.max,
        0.05,
        s.renderScale,
        (v) => this.store.update({ renderScale: v }),
        pct,
        'renderScale',
      ),
    );
    const actions = this.div('actions');
    actions.appendChild(
      this.button(
        'Reset',
        () => {
          this.store.reset();
          this.render();
        },
        'reset',
        true,
      ),
    );
    actions.appendChild(this.button('Done', () => this.closeSettings(), 'done'));
    panel.appendChild(actions);
    return panel;
  }

  private loadingScreen(): UiNode {
    const panel = this.panel();
    panel.appendChild(this.text('h2', 'Loading…'));
    panel.appendChild(this.text('div', this.flow.setup.map, 'sub'));
    return panel;
  }

  private endedScreen(): UiNode {
    const panel = this.panel('wide');
    const result = this.flow.result;
    const winner = result?.scoreboard.rows.find((r) => r.isWinner);
    panel.appendChild(this.text('h2', winner ? `${winner.name} wins` : 'Match over'));
    if (this.flow.overtime) panel.appendChild(this.text('div', 'Decided in overtime', 'sub'));
    const table = this.doc.createElement('table');
    table.className = 'scores';
    const head = this.doc.createElement('tr');
    for (const h of SCORE_HEADERS) head.appendChild(this.text('th', h));
    table.appendChild(head);
    for (const row of result?.scoreboard.rows ?? []) {
      const tr = this.doc.createElement('tr');
      tr.className = [
        'row',
        row.isWinner ? 'winner' : '',
        row.playerId === this.localPlayer ? 'local' : '',
      ]
        .filter(Boolean)
        .join(' ');
      for (const cell of scoreRowCells(row)) tr.appendChild(this.text('td', cell));
      table.appendChild(tr);
    }
    panel.appendChild(table);
    this.timer = this.text('div', `Back to the menu in ${END_SCREEN_SECONDS} s`, 'sub timer');
    panel.appendChild(this.timer);
    this.update();
    const actions = this.div('actions');
    actions.appendChild(this.button('Menu', () => this.flow.toMenu(), 'menu', true));
    actions.appendChild(this.button('Rematch', () => this.flow.rematch(), 'rematch'));
    panel.appendChild(actions);
    return panel;
  }

  // ---- builders ----

  private panel(extra = ''): UiNode {
    return this.div(`menu-panel ${extra}`.trim());
  }

  private div(className: string): UiNode {
    const el = this.doc.createElement('div');
    el.className = className;
    return el;
  }

  private text(tag: string, content: string, className = ''): UiNode {
    const el = this.doc.createElement(tag);
    el.textContent = content;
    if (className) el.className = className;
    return el;
  }

  private button(label: string, onClick: () => void, id: string, secondary = false): UiNode {
    const el = this.doc.createElement('button');
    el.textContent = label;
    el.className = secondary ? 'secondary' : 'primary';
    el.type = 'button';
    el.setAttribute('data-action', id);
    el.addEventListener('click', onClick);
    return el;
  }

  private field(label: string, id: string): { row: UiNode; control: UiNode } {
    const row = this.div('field');
    row.setAttribute('data-field', id);
    row.appendChild(this.text('span', label, 'label'));
    const control = this.div('control');
    row.appendChild(control);
    return { row, control };
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onChange: (v: number) => void,
    format: (v: number) => string,
    id: string,
  ): UiNode {
    const { row, control } = this.field(label, id);
    const input = this.doc.createElement('input');
    input.type = 'range';
    input.setAttribute('min', String(min));
    input.setAttribute('max', String(max));
    input.setAttribute('step', String(step));
    input.value = String(value);
    const readout = this.text('span', format(value), 'readout');
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      readout.textContent = format(v);
      onChange(v);
    });
    control.appendChild(input);
    control.appendChild(readout);
    return row;
  }

  private toggle(
    label: string,
    value: boolean,
    onChange: (v: boolean) => void,
    id: string,
  ): UiNode {
    const { row, control } = this.field(label, id);
    const input = this.doc.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    control.appendChild(input);
    return row;
  }

  private select(
    label: string,
    options: readonly { value: string; label: string }[],
    value: string,
    onChange: (v: string) => void,
    id: string,
  ): UiNode {
    const { row, control } = this.field(label, id);
    const select = this.doc.createElement('select');
    for (const o of options) {
      const opt = this.doc.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      select.appendChild(opt);
    }
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    control.appendChild(select);
    return row;
  }
}
