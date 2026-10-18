/**
 * Deathmatch rules and pickups contract (docs/DESIGN.md §6). Implemented by P11, P18, P23.
 */
import { describe, it } from 'vitest';

describe('pickups', () => {
  it.todo('health vial adds 5 up to 199');
  it.todo('health pack adds 25 up to 100 and does not reduce overheal');
  it.todo('shield pack adds 50 up to 150; super shield adds 100 up to 150');
  it.todo('weapon-stay pickups remain available and can be taken once per life per pawn');
  it.todo('non-weapon-stay pickups become unavailable and respawn after respawnSeconds');
  it.todo('redeemer pickup respawns after 60 s and emits redeemerAvailable');
});

describe('deathmatch rules', () => {
  it.todo('frag limit ends the match with the leader as winner');
  it.todo('time limit ends the match; a tie enters overtime');
  it.todo('suicide subtracts one frag');
  it.todo('telefrag counts as a frag for the teleporting pawn');
  it.todo('respawn requires respawnDelay to pass and Fire to be pressed, or 2 s to elapse');
  it.todo('spawn selection prefers points far from enemies with randomised tie-breaking');
  it.todo('firstBlood is announced once per match');
  it.todo('kills within 3 s escalate doubleKill → multiKill → megaKill → ultraKill → monsterKill');
  it.todo('sprees announce at 5, 10, 15, 20, 25 kills without dying');
  it.todo('threeFragsLeft/twoFragsLeft/oneFragLeft announce as the leader approaches the limit');
});
