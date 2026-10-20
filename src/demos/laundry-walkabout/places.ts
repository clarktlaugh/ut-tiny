/**
 * Teleport destinations for the walkabout (P31): the map's named cameras,
 * grounded (the pawn stands where the camera looks from, on the first surface
 * below the eye, facing the same way), plus the start of every §7.1 route
 * and hazard from `routes.ts`.
 */
import type { MapDef, Pose, Vec3 } from '../../sim/types';
import { ROUTES, type RouteGroup } from './routes';

export type PlaceGroup = 'camera' | RouteGroup;

export interface Place {
  /** `camera:overview`, `route:R1`, `hazard:H2`. */
  readonly id: string;
  readonly group: PlaceGroup;
  /** Short button text. */
  readonly label: string;
  /** One line under the label. */
  readonly hint: string;
  /** Feet on the surface, facing `yaw`/`pitch`. */
  readonly pose: Pose;
}

/** Ground point straight below `from` within `maxDrop` meters, or null when there is none. */
export type GroundProbe = (from: Readonly<Vec3>, maxDrop: number) => Vec3 | null;

/** How far below a camera eye the ground is searched for. */
export const CAMERA_GROUND_SEARCH = 200;

/** A camera's pose with the eye brought down to the ground below it. */
export function groundedCameraPose(camera: Readonly<Pose>, ground: GroundProbe): Pose {
  const feet = ground(camera.position, CAMERA_GROUND_SEARCH) ?? camera.position;
  return { position: { ...feet }, yaw: camera.yaw, pitch: camera.pitch };
}

export function cameraPlaces(map: MapDef, ground: GroundProbe): Place[] {
  return map.cameras.map((cam) => ({
    id: `camera:${cam.name}`,
    group: 'camera',
    label: cam.name.charAt(0).toUpperCase() + cam.name.slice(1),
    hint: 'Stand where this camera looks from.',
    pose: groundedCameraPose(cam.pose, ground),
  }));
}

export function routePlaces(): Place[] {
  return ROUTES.map((route) => ({
    id: `${route.group}:${route.id}`,
    group: route.group,
    label: `${route.id} · ${route.title}`,
    hint: route.howTo,
    pose: route.start,
  }));
}

/** Every destination, cameras first, then routes, then hazards. */
export function allPlaces(map: MapDef, ground: GroundProbe): Place[] {
  return [...cameraPlaces(map, ground), ...routePlaces()];
}

export function groupLabel(group: PlaceGroup): string {
  switch (group) {
    case 'camera':
      return 'Views';
    case 'route':
      return 'Routes (§7.1)';
    case 'hazard':
      return 'Hazards';
  }
}
