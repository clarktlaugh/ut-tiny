# Client shell (`src/client/`)

One reusable client for every demo and, later, the game (docs/DESIGN.md §8, §8.3, §8.4).

```ts
import { createClient, fxPlugin, hudPlugin } from '../../client';

const client = await createClient({
  canvas,                       // required
  map: LAUNDRY_ROOM,            // default; or pass a prebuilt `world`
  seed: 7,
  mountInputOverlay: (o) => shell.setInputOverlay(o), // demo shell hook for the touch controls
  pixelRatio: () => shell.pixelRatio(),
});
shell.trackRenderer(client.renderer as WebGLRenderer);
client.use(fxPlugin(client.scene, new FxSystem({ seed: 7, surface: raycastProbe([client.view.mapView.brushes]) })));
client.use(hudPlugin(new Hud(hudRoot, document, { weapons: WEAPONS, localPawn: client.localPawn })));
await client.firstFrame;
document.body.dataset.ready = '1';
```

What it does:

- Builds a `World` with `createWorld` (P29) and runs it in a `LocalSession`; the local player joins through a `LoopbackTransport`.
- Input: `PlayerController` with pointer lock on desktop; on touch devices (`(pointer: coarse)`, or `?touch=1` / `?touch=0`) the P27 `TouchController` and `TouchOverlay`.
- Rendering: `SceneView` mirrors the state with tick interpolation; `DefaultViewTargetResolver` picks the view target (pawn eyes, disc cam, warhead nose cam, spectator) and `cameraPoseFor` places the camera; the local body is hidden in first person; `ViewModel` is drawn as a second pass.
- Audio: `AudioSystem` on a `ThreeAudioBackend` (listener on the camera), fed every tick; resumed on the first gesture. Pass `audio: false` for silence.
- Resize on `resize` / `orientationchange` and settings changes; pause on blur and hidden page.

Hooks: `client.use(plugin)` with optional `tick(events, state)`, `frame(frame)` (camera placed, before drawing), `afterRender(frame)`, `resize(w, h)` and `dispose()`. `fxPlugin` and `hudPlugin` adapt the P16 FX system and the P19 HUD.

Tests inject `renderer`, `audio`, `window`, `document` and `scheduler` and drive frames with `client.session.advance(dt)` (see `client.test.ts`).

Not done here: the audio listener always sits at the camera (the disc cam's "listener at body" setting is resolved but not applied), and there is no picture-in-picture body view yet.
