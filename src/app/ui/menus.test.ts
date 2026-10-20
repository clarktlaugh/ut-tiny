import { describe, expect, it } from 'vitest';
import type { MatchPhase, MatchState, SimEvent } from '../../sim/types';
import { MatchFlow } from '../matchFlow';
import { MemoryStorage, SettingsStore } from '../settings';
import type { UiDocument, UiNode } from './dom';
import { MenuUi } from './menus';
import { setupFromSettings, skillName } from './model';
import { defaultSettings } from '../settings';

class FakeNode implements UiNode {
  className = '';
  textContent: string | null = '';
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  type = '';
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  listeners = new Map<string, (() => void)[]>();
  appendChild(c: UiNode) {
    this.children.push(c as FakeNode);
  }
  replaceChildren(...c: UiNode[]) {
    this.children = c as FakeNode[];
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  addEventListener(t: string, l: () => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]);
  }
  fire(t: string) {
    for (const l of this.listeners.get(t) ?? []) l();
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  action(id: string): FakeNode {
    const n = this.all().find((x) => x.attrs.get('data-action') === id);
    if (!n) throw new Error(`no action ${id}`);
    return n;
  }
  field(id: string): FakeNode {
    const n = this.all().find((x) => x.attrs.get('data-field') === id);
    if (!n) throw new Error(`no field ${id}`);
    return n;
  }
  input(id: string, value: string) {
    const control = this.field(id)
      .all()
      .find((x) => x.type === 'range')!;
    control.value = value;
    control.fire('input');
  }
  click(id: string) {
    this.action(id).fire('click');
  }
  texts(): string[] {
    return this.all().map((n) => n.textContent ?? '');
  }
}
const doc: UiDocument = { createElement: () => new FakeNode() };

const phase = (p: MatchPhase): SimEvent => ({ type: 'matchPhase', tick: 1, phase: p });

function endedMatch(): MatchState {
  return {
    phase: 'ended',
    fragLimit: 5,
    timeLimit: 0,
    elapsed: 61,
    winner: 'local',
    scores: [
      { playerId: 'bot:1', name: 'Bot', isBot: true, frags: 2, deaths: 5, suicides: 0, spree: 0 },
      { playerId: 'local', name: 'You', isBot: false, frags: 5, deaths: 2, suicides: 0, spree: 3 },
    ],
  };
}

function make() {
  const flow = new MatchFlow();
  const settings = new SettingsStore(new MemoryStorage());
  const root = new FakeNode();
  const menus = new MenuUi(root, doc, { flow, settings, localPlayer: 'local' });
  return { flow, settings, root, menus };
}

describe('MenuUi', () => {
  it('shows the main menu and Play starts a match with saved defaults', () => {
    const { flow, root, menus } = make();
    expect(menus.screen).toBe('main');
    expect(root.hidden).toBe(false);
    root.click('play');
    expect(flow.state).toBe('loading');
    expect(flow.setup).toMatchObject({ bots: 3, botSkill: 3, fragLimit: 25, timeLimit: 600 });
    expect(menus.screen).toBe('loading');
  });

  it('edits the match setup and saves it to settings on start', () => {
    const { flow, settings, root, menus } = make();
    root.click('setup');
    expect(menus.screen).toBe('setup');
    root.input('bots', '5');
    root.input('skill', '7');
    root.input('frags', '10');
    root.input('time', '0');
    expect(root.field('skill').texts()).toContain('Godlike');
    expect(root.field('time').texts()).toContain('Off');
    root.click('start');
    expect(flow.setup).toMatchObject({ bots: 5, botSkill: 7, fragLimit: 10, timeLimit: 0 });
    expect(settings.get()).toMatchObject({
      botCount: 5,
      botSkill: 7,
      fragLimit: 10,
      timeLimitMinutes: 0,
    });
  });

  it('Back from setup returns to the main menu', () => {
    const { flow, root, menus } = make();
    root.click('setup');
    root.click('back');
    expect(flow.state).toBe('menu');
    expect(menus.screen).toBe('main');
  });

  it('settings screen edits the store live and Reset restores defaults', () => {
    const { settings, root, menus } = make();
    root.click('settings');
    expect(menus.screen).toBe('settings');
    root.input('sensitivity', '2.5');
    root.input('fov', '90');
    root.input('volume-master', '0.25');
    const invert = root
      .field('invertY')
      .all()
      .find((n) => n.type === 'checkbox')!;
    invert.checked = true;
    invert.fire('change');
    expect(settings.get()).toMatchObject({ sensitivity: 2.5, fov: 90, invertY: true });
    expect(settings.get().volume.master).toBe(0.25);
    root.click('reset');
    expect(settings.get().fov).toBe(100);
    expect(settings.get().invertY).toBe(false);
    root.click('done');
    expect(menus.screen).toBe('main');
  });

  it('quality select updates the preset', () => {
    const { settings, root } = make();
    root.click('settings');
    const select = root
      .field('quality')
      .all()
      .find((n) => n.listeners.has('change'))!;
    select.value = 'low';
    select.fire('change');
    expect(settings.get().quality).toBe('low');
  });

  it('hides during countdown and play, shows the scoreboard on ended, then rematches', () => {
    const { flow, root, menus } = make();
    root.click('play');
    flow.loaded();
    expect(menus.screen).toBe('none');
    expect(root.hidden).toBe(true);
    flow.handleEvents([phase('playing')]);
    expect(root.hidden).toBe(true);
    flow.handleEvents([phase('ended')], endedMatch());
    expect(menus.screen).toBe('ended');
    expect(root.hidden).toBe(false);
    const texts = root.texts();
    expect(texts).toContain('You wins');
    expect(texts).toContain('Bot (bot)');
    expect(texts).toContain('71%');
    const rows = root.all().filter((n) => n.className.includes('row'));
    expect(rows[0]!.className).toContain('winner');
    expect(rows[0]!.className).toContain('local');
    expect(rows[1]!.className).not.toContain('winner');
    flow.update(3.2);
    menus.update();
    expect(root.texts()).toContain('Back to the menu in 7 s');
    root.click('rematch');
    expect(flow.state).toBe('loading');
  });

  it('returns to the main menu when the end timer runs out', () => {
    const { flow, root, menus } = make();
    root.click('play');
    flow.loaded();
    flow.handleEvents([phase('playing')]);
    flow.handleEvents([phase('ended')], endedMatch());
    flow.update(10);
    expect(menus.screen).toBe('main');
  });

  it('ignores openSettings outside the menu and stops rendering after dispose', () => {
    const { flow, root, menus } = make();
    root.click('play');
    menus.openSettings();
    expect(menus.screen).toBe('loading');
    menus.dispose();
    flow.loaded();
    expect(menus.screen).toBe('loading');
  });
});

describe('model', () => {
  it('maps settings to a setup and names skills', () => {
    expect(setupFromSettings(defaultSettings(), 'laundry-room')).toEqual({
      map: 'laundry-room',
      bots: 3,
      botSkill: 3,
      fragLimit: 25,
      timeLimit: 600,
    });
    expect(skillName(0)).toBe('Novice');
    expect(skillName(99)).toBe('Godlike');
  });
});
