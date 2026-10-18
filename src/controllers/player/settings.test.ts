// Tests for src/app/settings.ts (kept here because P8 owns this directory).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserStorage,
  defaultSettings,
  loadSettings,
  MemoryStorage,
  sanitizeSettings,
  saveSettings,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
} from '../../app/settings';
import { defaultBindings, rebind, unbind } from './bindings';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings persistence', () => {
  it('bindings round-trip through localStorage', () => {
    const storage = new MemoryStorage();
    vi.stubGlobal('localStorage', storage);

    let bindings = rebind(defaultBindings(), 'jump', 'Mouse1');
    bindings = rebind(bindings, 'dodgeLeft', 'KeyZ');
    bindings = unbind(bindings, 'use');
    const store = new SettingsStore();
    store.setBindings(bindings);

    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}').bindings.jump).toEqual([
      'Space',
      'Mouse1',
    ]);
    const reloaded = new SettingsStore().get();
    expect(reloaded.bindings).toEqual(bindings);
    expect(reloaded.bindings).not.toBe(bindings);
  });

  it('round-trips every setting', () => {
    const storage = new MemoryStorage();
    const s = {
      ...defaultSettings(),
      sensitivity: 2.5,
      fov: 90,
      invertY: true,
      doubleTapDodge: false,
      quality: 'high' as const,
      botCount: 7,
      volume: { master: 0.3, sfx: 0.4, music: 0, announcer: 0.9 },
    };
    expect(saveSettings(s, storage)).toBe(true);
    expect(loadSettings(storage)).toEqual(s);
  });

  it('falls back to defaults for missing, corrupt or out-of-range data', () => {
    const storage = new MemoryStorage();
    expect(loadSettings(storage)).toEqual(defaultSettings());
    storage.setItem(SETTINGS_STORAGE_KEY, '{not json');
    expect(loadSettings(storage)).toEqual(defaultSettings());
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        fov: 200,
        botSkill: 3.6,
        quality: 'ultra',
        invertY: 'yes',
        volume: { sfx: -1 },
      }),
    );
    const s = loadSettings(storage);
    expect(s.fov).toBe(110);
    expect(s.botSkill).toBe(4);
    expect(s.quality).toBe('medium');
    expect(s.invertY).toBe(false);
    expect(s.volume.sfx).toBe(0);
    expect(sanitizeSettings([1, 2])).toEqual(defaultSettings());
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(loadSettings(broken)).toEqual(defaultSettings());
    expect(saveSettings(defaultSettings(), broken)).toBe(false);
    vi.stubGlobal('localStorage', broken);
    expect(browserStorage()).toBeInstanceOf(MemoryStorage);
  });

  it('store updates merge, persist and notify', () => {
    const storage = new MemoryStorage();
    const store = new SettingsStore(storage);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.update({ fov: 85, volume: { music: 0.1 } });
    expect(store.get().fov).toBe(85);
    expect(store.get().volume).toEqual({ ...defaultSettings().volume, music: 0.1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loadSettings(storage).fov).toBe(85);
    off();
    store.reset();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loadSettings(storage)).toEqual(defaultSettings());
  });
});
