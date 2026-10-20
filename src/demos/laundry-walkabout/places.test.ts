import { describe, expect, it } from 'vitest';
import { LAUNDRY_ROOM } from '../../maps/laundry-room';
import { allPlaces, cameraPlaces, groundedCameraPose, groupLabel, routePlaces } from './places';
import { ROUTES } from './routes';

describe('walkabout places', () => {
  it('grounds a camera eye on the surface below it, keeping its view', () => {
    const cam = { position: { x: 1, y: 50, z: 2 }, yaw: 0.3, pitch: -0.4 };
    const grounded = groundedCameraPose(cam, (from, maxDrop) => {
      expect(from).toEqual(cam.position);
      expect(maxDrop).toBeGreaterThan(96);
      return { x: from.x, y: 7, z: from.z };
    });
    expect(grounded).toEqual({ position: { x: 1, y: 7, z: 2 }, yaw: 0.3, pitch: -0.4 });
    // No ground found: the eye itself.
    expect(groundedCameraPose(cam, () => null).position).toEqual(cam.position);
  });

  it('lists every named camera, route and hazard once with unique ids', () => {
    const places = allPlaces(LAUNDRY_ROOM, (from) => ({ ...from, y: 0 }));
    expect(places.length).toBe(LAUNDRY_ROOM.cameras.length + ROUTES.length);
    expect(new Set(places.map((p) => p.id)).size).toBe(places.length);
    expect(cameraPlaces(LAUNDRY_ROOM, (from) => from).map((p) => p.label)).toContain('Overview');
    for (const p of routePlaces()) {
      expect(p.id).toMatch(/^(route|hazard):[A-Z]\d+b?$/);
      expect(p.hint.trim()).not.toBe('');
      expect(p.label).toContain(p.id.split(':')[1]!);
    }
    expect(['Views', 'Routes (§7.1)', 'Hazards']).toEqual(
      (['camera', 'route', 'hazard'] as const).map(groupLabel),
    );
  });
});
