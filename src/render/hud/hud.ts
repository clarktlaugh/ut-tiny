/**
 * Heads-up display (docs/DESIGN.md §11): health and shield bottom-left, ammo
 * bottom-right, weapon bar bottom-center, kill feed top-right, announcer text
 * center-top, frags and clock top-left, per-weapon crosshair with a zoom
 * readout.
 *
 * Per rendered frame:
 *   hud.handleEvents(eventsSinceLastFrame, state);
 *   hud.update(state);
 *
 * It reads `WorldState` and the weapon table only; it never touches the sim.
 */
import type { PawnId, PawnState, SimEvent, WeaponDef, WeaponId, WorldState } from '../../sim/types';
import type { HudDocument, HudNode } from './dom';
import {
  KILL_FEED_MAX,
  feedFromEvents,
  readoutFor,
  statusFor,
  weaponBarFor,
  type AnnouncerMessage,
  type KillFeedEntry,
} from './model';

export interface HudOptions {
  weapons: Readonly<Record<WeaponId, WeaponDef>>;
  /** Pawn whose state the HUD shows. */
  localPawn: PawnId;
}

export class Hud {
  private readonly doc: HudDocument;
  private readonly opts: HudOptions;
  private kills: KillFeedEntry[] = [];
  private announcement: AnnouncerMessage | null = null;

  private readonly status: HudNode;
  private readonly feed: HudNode;
  private readonly announcer: HudNode;
  private readonly healthRow: HudNode;
  private readonly healthNum: HudNode;
  private readonly healthFill: HudNode;
  private readonly shieldRow: HudNode;
  private readonly shieldNum: HudNode;
  private readonly shieldFill: HudNode;
  private readonly ammo: HudNode;
  private readonly ammoNum: HudNode;
  private readonly ammoName: HudNode;
  private readonly bar: HudNode;
  private readonly cross: HudNode;
  private readonly zoom: HudNode;
  private readonly dead: HudNode;
  private readonly power: HudNode;
  private readonly frags: HudNode;
  private readonly clock: HudNode;
  private readonly phase: HudNode;

  constructor(
    readonly root: HudNode,
    doc: HudDocument,
    opts: HudOptions,
  ) {
    this.doc = doc;
    this.opts = opts;
    root.className = 'hud';

    this.status = this.add(root, 'hud-status');
    this.frags = this.add(this.status, 'frags');
    this.clock = this.add(this.status, 'clock');
    this.phase = this.add(this.status, 'phase');
    this.feed = this.add(root, 'hud-feed');
    this.announcer = this.add(root, 'hud-announcer');

    const vitals = this.add(root, 'hud-vitals');
    this.healthRow = this.add(vitals, 'row hud-health');
    this.healthNum = this.add(this.healthRow, 'num');
    this.healthFill = this.bar2(this.healthRow);
    this.shieldRow = this.add(vitals, 'row hud-shield');
    this.shieldNum = this.add(this.shieldRow, 'num');
    this.shieldFill = this.bar2(this.shieldRow);

    this.ammo = this.add(root, 'hud-ammo');
    this.ammoNum = this.add(this.ammo, 'num');
    this.ammoName = this.add(this.ammo, 'name');
    this.bar = this.add(root, 'hud-bar');
    this.cross = this.add(root, 'hud-cross none');
    this.add(this.cross, '', 'i');
    this.zoom = this.add(root, 'hud-zoom');
    this.dead = this.add(root, 'hud-dead');
    this.dead.textContent = 'Press Fire to respawn';
    this.power = this.add(root, 'hud-power');
  }

  private add(parent: HudNode, className: string, tag = 'div'): HudNode {
    const el = this.doc.createElement(tag);
    el.className = className;
    parent.appendChild(el);
    return el;
  }

  private bar2(row: HudNode): HudNode {
    const track = this.add(row, 'bar');
    return this.add(track, 'fill');
  }

  /** Feed sim events from the frame (kill feed, announcer text). */
  handleEvents(events: readonly SimEvent[], state: Readonly<WorldState>): void {
    const { kills, announcements } = feedFromEvents(events, state, this.opts.localPawn);
    if (kills.length) this.kills = [...this.kills, ...kills].slice(-KILL_FEED_MAX);
    const last = announcements[announcements.length - 1];
    if (last) this.announcement = last;
  }

  /** Redraw from the current state. Call once per rendered frame. */
  update(state: Readonly<WorldState>): void {
    const pawn = state.entities.find(
      (e): e is PawnState => e.kind === 'pawn' && e.id === this.opts.localPawn,
    );
    this.kills = this.kills.filter((k) => k.expiresAt > state.time);
    if (this.announcement && this.announcement.expiresAt <= state.time) this.announcement = null;

    this.feed.replaceChildren(
      ...this.kills.map((k) => {
        const el = this.doc.createElement('div');
        el.className = `kill${k.mine ? ' mine' : ''}${k.against ? ' against' : ''}`;
        el.textContent = k.text;
        return el;
      }),
    );
    this.announcer.textContent = this.announcement?.text ?? '';
    this.announcer.hidden = !this.announcement;

    if (!pawn) return;
    const status = statusFor(state.match, pawn.playerId);
    this.frags.textContent = status.frags;
    this.clock.textContent = status.clock;
    this.phase.textContent = status.phase;

    const r = readoutFor(pawn, this.opts.weapons, state.tick);
    this.healthNum.textContent = String(r.health);
    this.healthRow.className = `row hud-health${r.lowHealth ? ' low' : ''}`;
    this.healthFill.style.setProperty('width', `${Math.min(100, r.health)}%`);
    this.shieldNum.textContent = String(r.shield);
    this.shieldFill.style.setProperty('width', `${Math.min(100, r.shield)}%`);
    this.shieldRow.hidden = r.shield <= 0;

    this.ammo.hidden = !r.alive || r.weaponLabel === '';
    this.ammoNum.textContent = r.infiniteAmmo ? '∞' : String(r.ammo ?? 0);
    this.ammoName.textContent = r.weaponLabel;

    this.bar.replaceChildren(
      ...weaponBarFor(pawn, this.opts.weapons).map((s) => {
        const el = this.doc.createElement('div');
        el.className = `hud-slot${s.owned ? ' owned' : ''}${s.selected ? ' selected' : ''}`;
        el.setAttribute('data-weapon', s.weapon);
        el.textContent = s.ammo === null ? String(s.slot) : `${s.slot} · ${s.ammo}`;
        return el;
      }),
    );

    this.cross.className = `hud-cross ${r.crosshair}`;
    this.zoom.textContent = r.zoomText;
    this.zoom.hidden = r.zoomText === '';
    this.dead.hidden = r.alive;
    const powers = [r.udamage ? 'Damage Amp' : '', r.protectedSpawn ? 'Protected' : ''];
    this.power.textContent = powers.filter(Boolean).join(' · ');
  }
}
