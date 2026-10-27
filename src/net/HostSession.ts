import { Game, type GameEvents } from '../game/Game';
import { isMole } from '../game/entities';
import { PHASES, isInput, type HostMsg, type Snapshot } from './protocol';
import type { RelayLink } from './RelayLink';
import type { SaveState } from '../game/save';

const SNAPSHOT_HZ = 20;
/** The level intro only swings the hooks, which the guest simulates itself. */
const INTRO_SNAPSHOT_HZ = 2;

/**
 * Runs the authoritative two-player game on the host device and mirrors it to the
 * guest: phase changes and events over the reliable channel, state snapshots over the
 * lossy one. Guest inputs are applied to player 2.
 */
export class HostSession {
  readonly game: Game;
  private seq = 0;
  private acc = 0;
  private closed = false;

  constructor(
    readonly link: RelayLink,
    ui: Partial<GameEvents>,
    private onPeerLeft: () => void,
    private onPeerBack: () => void,
  ) {
    const send = (m: HostMsg) => this.link.send(m);
    this.game = new Game({
      onStateChange: (s) => {
        ui.onStateChange?.(s);
        send(this.phaseMsg());
      },
      onFire: (p) => {
        ui.onFire?.(p);
        send({ t: 'ev', k: 'fire', p });
      },
      onGrab: (e, p) => {
        ui.onGrab?.(e, p);
        send({ t: 'ev', k: 'grab', p, id: e.id });
      },
      onCash: (e, amount, p) => {
        ui.onCash?.(e, amount, p);
        send({ t: 'ev', k: 'cash', p, id: e.id, amount, x: e.x, y: e.y });
      },
      onBag: (o, p) => {
        ui.onBag?.(o, p);
        const e = this.game.level.entities.find((x) => x.kind === 'bag' && x.taken) ?? { id: -1, x: 800, y: 500 };
        send({ t: 'ev', k: 'bag', p, id: e.id, outcome: o, x: e.x, y: e.y });
        send({ t: 'buffs', buffs: this.game.buffs });
      },
      onDynamite: (p, blast) => {
        ui.onDynamite?.(p, blast);
        send({ t: 'ev', k: 'dyn', p, x: blast.x, y: blast.y, kind: blast.kind });
      },
      onTick: (s) => {
        ui.onTick?.(s);
        send({ t: 'ev', k: 'tick', s });
      },
    });
    this.game.isOnline = true;
    link.onMessageHandler = (m) => this.onMessage(m);
    link.onPeerLeft = () => {
      if (this.closed) return;
      this.game.pause();
      this.onPeerLeft();
    };
    link.onPeerJoined = () => {
      if (this.closed) return;
      // (Re)joined: bring the guest fully up to date.
      this.sendHello();
      this.link.send(this.phaseMsg());
      this.onPeerBack();
    };
    link.onCloseHandler = () => {
      if (this.closed) return;
      this.game.pause();
      this.onPeerLeft();
    };
  }

  private sendHello(): void {
    this.link.send({
      t: 'hello',
      seed: this.game.save.seed,
      level: this.game.save.level,
      money: this.game.save.money,
      inventory: this.game.save.inventory,
    });
  }

  start(save: SaveState | null): void {
    if (save) this.game.continueGame(save, 2);
    else this.game.newGame(2);
    this.sendHello();
    this.link.send(this.phaseMsg());
  }

  private phaseMsg(): HostMsg {
    const g = this.game;
    return {
      t: 'phase',
      state: g.state,
      seed: g.save.seed,
      level: g.save.level,
      goal: g.level.goal,
      money: g.save.money,
      inventory: g.save.inventory,
      offers: g.offers,
      cleared: g.lastResultCleared,
      buffs: g.buffs,
    };
  }

  private onMessage(m: unknown): void {
    if (!isInput(m)) return;
    const g = this.game;
    switch (m.k) {
      case 'fire':
        if (g.state === 'levelIntro') g.primary(1);
        else if (typeof m.a === 'number' && Number.isFinite(m.a)) g.fireAt(1, m.a);
        break;
      case 'dyn':
        g.useDynamite(1);
        break;
      case 'start':
        g.primary(1);
        break;
      case 'buy': {
        const offer = g.offers.find((o) => o.id === m.id);
        if (offer && g.buy(offer)) this.link.send(this.phaseMsg());
        break;
      }
      case 'pause':
        g.pause();
        break;
      case 'resume':
        g.resume();
        break;
      case 'restart':
        g.restartLevel();
        break;
    }
  }

  /** Call every animation frame after game.frame(). */
  frame(dt: number): void {
    const state = this.game.state;
    if (state !== 'playing' && state !== 'levelIntro') return;
    // Nobody to mirror to: every relayed message costs a relay request, so stay quiet.
    // A returning guest gets hello + phase on peer-joined and snapshots resume from there.
    if (!this.link.peerPresent) return;
    this.acc += dt;
    if (this.acc < 1 / (state === 'playing' ? SNAPSHOT_HZ : INTRO_SNAPSHOT_HZ)) return;
    this.acc = 0;
    const g = this.game;
    const snap: Snapshot = {
      t: 's',
      q: ++this.seq,
      tl: g.timeLeft,
      m: g.players.map((p) => p.levelMoney),
      d: g.buffs.dynamite,
      h: g.players.map((p) => [
        round(p.hook.angle, 4),
        round(p.hook.length, 1),
        PHASES.indexOf(p.hook.phase),
        p.hook.grabbed ? p.hook.grabbed.id : -1,
        round(p.hook.swingClock, 3),
      ]),
      e: g.level.entities.filter((e) => !e.taken && isMole(e.kind)).map((e) => [e.id, round(e.x, 1), round(e.y, 1)]),
      tk: g.level.entities.filter((e) => e.taken).map((e) => e.id),
    };
    this.link.sendSnapshot(snap);
  }

  /** Host is leaving (quit to menu / continue alone). */
  end(): void {
    this.closed = true;
    this.link.send({ t: 'bye' });
    setTimeout(() => this.link.close(), 200);
  }
}

function round(v: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
