import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  codeToActions,
  DEFAULT_BINDINGS,
  defaultBindings,
  rebind,
  sanitizeBindings,
  unbind,
} from './bindings';

describe('bindings', () => {
  it('defaults cover every action and no code is bound twice', () => {
    const seen = new Set<string>();
    for (const action of ACTIONS) {
      expect(Array.isArray(DEFAULT_BINDINGS[action])).toBe(true);
      for (const code of DEFAULT_BINDINGS[action]) {
        expect(seen.has(code)).toBe(false);
        seen.add(code);
      }
    }
  });

  it('rebind moves a code off any other action', () => {
    const b = rebind(defaultBindings(), 'jump', 'KeyW');
    expect(b.jump).toEqual(['Space', 'KeyW']);
    expect(b.moveForward).toEqual(['ArrowUp']);
    expect(codeToActions(b).get('KeyW')).toEqual(['jump']);
    expect(DEFAULT_BINDINGS.moveForward).toContain('KeyW');
  });

  it('unbind clears one action', () => {
    expect(unbind(defaultBindings(), 'use').use).toEqual([]);
  });

  it('sanitize drops junk and fills missing actions', () => {
    const b = sanitizeBindings({ jump: ['KeyJ', 7, '', 'KeyJ'], bogus: ['KeyZ'], fire: 'Mouse0' });
    expect(b.jump).toEqual(['KeyJ']);
    expect(b.fire).toEqual(DEFAULT_BINDINGS.fire);
    expect(b.moveBack).toEqual(DEFAULT_BINDINGS.moveBack);
    expect('bogus' in b).toBe(false);
    expect(sanitizeBindings(null)).toEqual(defaultBindings());
  });
});
