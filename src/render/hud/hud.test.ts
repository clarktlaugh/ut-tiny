import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../../data/weapons';
import type { SimEvent } from '../../sim/types';
import type { HudDocument, HudNode } from './dom';
import { Hud } from './hud';
import { formatClock, readoutFor, statusFor, weaponBarFor } from './model';
import { ENEMY_PAWN, LOCAL_PAWN, mockPawn, mockState } from './mockState';

class FakeNode implements HudNode {
  className = '';
  textContent: string | null = '';
  hidden = false;
  props = new Map<string, string>();
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  style = { setProperty: (n: string, v: string) => void this.props.set(n, v) };
  appendChild(c: HudNode) {
    this.children.push(c as FakeNode);
  }
  replaceChildren(...c: HudNode[]) {
    this.children = c as FakeNode[];
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  find(cls: string): FakeNode | undefined {
    if (this.className.split(' ').includes(cls)) return this;
    for (const c of this.children) {
      const f = c.find(cls);
      if (f) return f;
    }
    return undefined;
  }
}
const doc: HudDocument = { createElement: () => new FakeNode() };

function make() {
  const root = new FakeNode();
  const hud = new Hud(root, doc, { weapons: WEAPONS, localPawn: LOCAL_PAWN });
  return { root, hud };
}

describe('Hud', () => {
  it('renders vitals, ammo, weapon bar, status and crosshair from a mocked state', () => {
    const { root, hud } = make();
    hud.update(mockState());
    expect(root.find('hud-health')!.find('num')!.textContent).toBe('100');
    expect(root.find('hud-shield')!.find('num')!.textContent).toBe('50');
    expect(root.find('hud-ammo')!.find('num')!.textContent).toBe('14');
    expect(root.find('hud-ammo')!.find('name')!.textContent).toBe('Rocket Launcher');
    const bar = root.find('hud-bar')!;
    expect(bar.children).toHaveLength(8);
    const selected = bar.children.filter((c) => c.className.includes('selected'));
    expect(selected.map((c) => c.attrs.get('data-weapon'))).toEqual(['rocket']);
    expect(bar.children[0]!.textContent).toBe('1');
    expect(bar.children[3]!.textContent).toBe('4 · 14');
    expect(root.find('frags')!.textContent).toBe('Frags 7 / 20');
    expect(root.find('clock')!.textContent).toBe('7:55');
    expect(root.find('hud-cross')!.className).toBe('hud-cross bracket');
  });

  it('shows low health, hides shield at zero, and the dead prompt', () => {
    const { root, hud } = make();
    hud.update(mockState({ health: 20, shield: 0 }));
    expect(root.find('hud-health')!.className).toContain('low');
    expect(root.find('hud-shield')!.hidden).toBe(true);
    expect(root.find('hud-dead')!.hidden).toBe(true);
    hud.update(mockState({ alive: false, health: 0 }));
    expect(root.find('hud-dead')!.hidden).toBe(false);
    expect(root.find('hud-cross')!.className).toBe('hud-cross none');
    expect(root.find('hud-ammo')!.hidden).toBe(true);
  });

  it('shows a scope crosshair and magnification when zoomed', () => {
    const { root, hud } = make();
    hud.update(mockState({ weapon: 'sniper', owned: ['sniper'], ammo: { sniper: 8 }, zoom: 4 }));
    expect(root.find('hud-cross')!.className).toBe('hud-cross scope');
    expect(root.find('hud-zoom')!.textContent).toBe('4.0x');
  });

  it('shows infinity for the translocator', () => {
    const { root, hud } = make();
    hud.update(mockState({ weapon: 'teleporter' }));
    expect(root.find('hud-ammo')!.find('num')!.textContent).toBe('∞');
  });

  it('adds kill feed entries from death events and expires them', () => {
    const { root, hud } = make();
    const state = mockState();
    const events: SimEvent[] = [
      {
        type: 'death',
        tick: 1,
        victim: ENEMY_PAWN,
        killer: LOCAL_PAWN,
        damageType: 'rocket',
        weapon: 'rocket',
      },
      { type: 'death', tick: 1, victim: LOCAL_PAWN, killer: 0, damageType: 'fall', weapon: null },
    ];
    hud.handleEvents(events, state);
    hud.update(state);
    const feed = root.find('hud-feed')!;
    expect(feed.children.map((c) => c.textContent)).toEqual([
      'You fragged Sock Bot [Rocket Launcher]',
      'You fell too far',
    ]);
    expect(feed.children[0]!.className).toContain('mine');
    expect(feed.children[1]!.className).toContain('against');
    hud.update(mockState({}, 200));
    expect(feed.children).toHaveLength(0);
  });

  it('caps the kill feed length', () => {
    const { root, hud } = make();
    const state = mockState();
    const death: SimEvent = {
      type: 'death',
      tick: 1,
      victim: ENEMY_PAWN,
      killer: LOCAL_PAWN,
      damageType: 'bullet',
      weapon: 'assault',
    };
    hud.handleEvents(Array(9).fill(death), state);
    hud.update(state);
    expect(root.find('hud-feed')!.children).toHaveLength(5);
  });

  it('shows announcer text addressed to everyone or the local pawn, then clears it', () => {
    const { root, hud } = make();
    const state = mockState();
    hud.handleEvents(
      [{ type: 'announcer', tick: 1, line: 'firstBlood', toPawn: ENEMY_PAWN }],
      state,
    );
    hud.update(state);
    expect(root.find('hud-announcer')!.hidden).toBe(true);
    hud.handleEvents([{ type: 'announcer', tick: 1, line: 'godlike', toPawn: 0 }], state);
    hud.update(state);
    expect(root.find('hud-announcer')!.textContent).toBe('Godlike');
    expect(root.find('hud-announcer')!.hidden).toBe(false);
    hud.update(mockState({}, 110));
    expect(root.find('hud-announcer')!.hidden).toBe(true);
  });
});

describe('model', () => {
  it('marks the pending weapon as selected in the bar', () => {
    const bar = weaponBarFor(mockPawn({ pendingWeapon: 'shock' }), WEAPONS);
    expect(bar.filter((s) => s.selected).map((s) => s.weapon)).toEqual(['shock']);
    expect(bar.filter((s) => s.owned)).toHaveLength(4);
  });

  it('flags power-ups from ticks', () => {
    const r = readoutFor(mockPawn({ udamageUntil: 500 }), WEAPONS, 100);
    expect(r.udamage).toBe(true);
    expect(readoutFor(mockPawn({ udamageUntil: 50 }), WEAPONS, 100).udamage).toBe(false);
  });

  it('formats clocks and counts up without a time limit', () => {
    expect(formatClock(65)).toBe('1:05');
    const m = mockState().match;
    expect(statusFor({ ...m, timeLimit: 0, fragLimit: 0 }, 'you')).toMatchObject({
      frags: 'Frags 7',
      clock: '2:05',
    });
  });
});
