/**
 * Transport contract (docs/DESIGN.md §10). Implemented by P3 (loopback) and M8 (Playroom).
 */
import { describe, it } from 'vitest';

describe('Transport', () => {
  it.todo('loopback isHost is true and players() contains only localPlayerId');
  it.todo('sendInput on a client is delivered to the host onInput with the sender id');
  it.todo('sendSnapshot on the host is delivered to every client onSnapshot');
  it.todo('onMatchState fires immediately with the current value if one is known');
  it.todo('unsubscribe functions stop further callbacks');
  it.todo('close() releases all listeners and makes further sends no-ops');
});

describe('ViewTargetResolver (§5.1)', () => {
  it.todo('resolves to the pawn eye with view model when nothing special is happening');
  it.todo(
    'resolves to the disc with velocity orientation while viewingDisc and the disc is in flight',
  );
  it.todo(
    'resolves to the disc with freeLook orientation while viewingDisc and the disc has landed',
  );
  it.todo('resolves to the warhead with nose orientation and no mouse look while guiding');
  it.todo('shows the static overlay for one frame burst after the target is destroyed');
  it.todo('honors discCamListener and allowPip settings');
});
