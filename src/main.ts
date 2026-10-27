import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { Game, type BagOutcome, type GameEvents, type GameState, type GameView } from './game/Game';
import { ITEM_SPECS, isRock } from './game/entities';
import { WORLD_W } from './game/Level';
import { clearStoredSave, persistSave, pickSave, readSaveFromHash, readSaveFromStorage, type SaveState } from './game/save';
import { detectLang, onLangChange, setLang, t, type StringKey } from './i18n';
import { Renderer } from './render/renderer';
import { Overlay } from './ui/overlay';
import { Sfx } from './audio/sfx';
import { ITEM_ICON, PAUSE_ICON } from './ui/icons';
import { HostSession } from './net/HostSession';
import { RemoteGame } from './net/RemoteGame';
import { RelayLink, createRoom, relayConfigured, roomInfo, roomLink } from './net/RelayLink';

setLang(detectLang(), false);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
const dynamiteBtn = document.getElementById('dynamiteBtn') as HTMLButtonElement;
const dynamiteBtn2 = document.getElementById('dynamiteBtn2') as HTMLButtonElement;
const sfx = new Sfx();
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

/* ---------- UI reactions shared by the local game and the online mirror ---------- */

const uiEvents: GameEvents = {
  onStateChange: (state: GameState) => {
    pauseBtn.classList.toggle('hidden', state !== 'playing');
    switch (state) {
      case 'menu':
        endOnline();
        overlay.pendingSave = view.save.level > 0 && view.save.seed ? { ...view.save } : readSaveFromStorage();
        overlay.alternativeSave = null;
        overlay.menu();
        break;
      case 'levelIntro':
        overlay.levelIntro();
        break;
      case 'playing':
        overlay.hide();
        break;
      case 'paused':
        overlay.paused();
        break;
      case 'levelResult':
        sfx.levelClear();
        overlay.levelResult();
        break;
      case 'shop':
        overlay.shop(() => sfx.buy());
        break;
      case 'gameOver':
        sfx.gameOver();
        overlay.gameOver();
        break;
    }
    updateDynamiteBtn();
  },
  onFire: () => sfx.fire(),
  onGrab: (e) => (isRock(e.kind) ? sfx.rock() : sfx.grab()),
  onCash: (e, amount) => {
    sfx.cash(amount >= ITEM_SPECS.goldL.value || e.kind === 'diamond' || e.kind === 'moleDiamond');
    updateDynamiteBtn();
  },
  onBag: (o: BagOutcome) => {
    sfx.bag(o.type !== 'nothing');
    if (o.type === 'cash') overlay.toast(t('bag.cash', { amount: o.amount }));
    else if (o.type === 'item') overlay.toast(t('bag.item', { item: t(`item.${o.item}` as StringKey) }));
    else overlay.toast(t('bag.nothing'));
    updateDynamiteBtn();
  },
  onDynamite: (_p, blast) => {
    sfx.dynamite();
    renderer.burst(blast.x, blast.y, blast.kind);
    updateDynamiteBtn();
  },
  onTick: (s) => {
    if (s <= 5 && s > 0) sfx.tick();
  },
};

const localGame = new Game(uiEvents);
/** What is being played and drawn: the local game, or the guest's mirror of a remote host. */
let view: GameView = localGame;
let host: HostSession | null = null;
let remote: RemoteGame | null = null;
/** Link being set up in a lobby, before a session exists. */
let pendingLink: RelayLink | null = null;

function setView(v: GameView): void {
  view = v;
  overlay.setGame(v);
  updateDynamiteBtn();
}

function endOnline(): void {
  pendingLink?.close();
  pendingLink = null;
  if (host) {
    host.end();
    host = null;
  }
  if (remote) {
    remote.link.close();
    remote = null;
  }
  if (view !== localGame) setView(localGame);
}

const overlay = new Overlay(localGame, {
  newGame: (players) => {
    sfx.unlock();
    endOnline();
    localGame.newGame(players);
  },
  continueGame: (s) => {
    sfx.unlock();
    endOnline();
    localGame.continueGame(s);
  },
  createOnline: () => {
    sfx.unlock();
    void startHosting();
  },
  joinWithCode: () => {
    sfx.unlock();
    overlay.enterCode(
      (text) => {
        const code = text.trim().toUpperCase();
        if (/^[A-Z2-9]{6}$/.test(code)) void startJoining(code);
        else overlay.toast(t('online.noRoom'));
      },
      () => localGame.quitToMenu(),
    );
  },
  toggleSound: () => {
    sfx.unlock();
    sfx.setMuted(!sfx.muted);
    return sfx.muted;
  },
  isMuted: () => sfx.muted,
  isTouch: () => isTouch,
});

const renderer = new Renderer(canvas);

/* ---------- Online: host ---------- */

async function startHosting(): Promise<void> {
  endOnline();
  const cancel = () => localGame.quitToMenu();
  if (!relayConfigured()) {
    overlay.lobby({ status: 'notConfigured', onRetry: startHosting, onCancel: cancel });
    return;
  }
  const resumeSave: SaveState | null = overlay.pendingSave;
  let resume = !!resumeSave;
  const continueAlone = () => {
    const save = host?.game.save ?? localGame.save;
    endOnline();
    localGame.continueGame({ ...save, players: 1 });
  };
  overlay.lobby({ status: 'preparing', onRetry: startHosting, onCancel: cancel });
  let link: RelayLink;
  try {
    const code = await createRoom();
    link = new RelayLink('host', code);
    // Still in the lobby: nothing to continue. In a game: keep the progress, play solo.
    link.onIdle = () => overlay.roomIdle(cancel, host ? continueAlone : undefined);
    pendingLink = link;
    await link.connect();
  } catch {
    if (pendingLink && pendingLink !== link!) return;
    pendingLink = null;
    overlay.lobby({ status: 'failed', onRetry: startHosting, onCancel: cancel });
    return;
  }
  if (pendingLink !== link) return; // cancelled meanwhile
  const showLobby = () =>
    overlay.lobby({
      status: 'waiting',
      code: link.code,
      link: roomLink(link.code),
      onRetry: startHosting,
      onCancel: cancel,
      resume: resumeSave
        ? {
            level: resumeSave.level,
            money: resumeSave.money,
            enabled: resume,
            toggle: () => {
              resume = !resume;
            },
          }
        : undefined,
    });
  showLobby();
  link.onCloseHandler = () => {
    if (pendingLink !== link) return;
    pendingLink = null;
    overlay.lobby({ status: 'failed', onRetry: startHosting, onCancel: cancel });
  };
  link.onPeerJoined = () => {
    if (pendingLink !== link) return;
    pendingLink = null;
    overlay.toast(t('online.connected'));
    host = new HostSession(
      link,
      uiEvents,
      () => overlay.peerLeft(continueAlone, () => localGame.quitToMenu()),
      () => {
        overlay.toast(t('online.peerBack'));
        // Back to whatever the game state's overlay is (paused, most likely).
        uiEvents.onStateChange(host!.game.state);
      },
    );
    link.onReconnecting = () => overlay.reconnecting(() => localGame.quitToMenu());
    link.onOpen = () => host && uiEvents.onStateChange(host.game.state);
    setView(host.game);
    host.start(resume ? resumeSave : null);
  };
  if (link.peerPresent) link.onPeerJoined();
}

/* ---------- Online: guest ---------- */

async function startJoining(code: string): Promise<void> {
  endOnline();
  const cancel = () => {
    history.replaceState(null, '', location.pathname + location.search);
    localGame.quitToMenu();
  };
  const retry = () => void startJoining(code);
  if (!relayConfigured()) {
    overlay.join({ status: 'notConfigured', onRetry: retry, onCancel: cancel });
    return;
  }
  overlay.join({ status: 'joining', onRetry: retry, onCancel: cancel });
  let link: RelayLink | null = null;
  try {
    const info = await roomInfo(code);
    if (!info.exists) {
      overlay.join({ status: 'noRoom', onRetry: retry, onCancel: cancel });
      return;
    }
    if (info.guest) {
      overlay.join({ status: 'roomFull', onRetry: retry, onCancel: cancel });
      return;
    }
    link = new RelayLink('guest', code);
    link.onIdle = () => overlay.roomIdle(cancel);
    pendingLink = link;
    await link.connect();
  } catch {
    if (link && pendingLink !== link) return;
    pendingLink = null;
    overlay.join({ status: 'failed', onRetry: retry, onCancel: cancel });
    return;
  }
  if (pendingLink !== link) return;
  pendingLink = null;
  history.replaceState(null, '', location.pathname + location.search);
  overlay.toast(t('online.connected'));
  remote = new RemoteGame(link, uiEvents, (final) => {
    overlay.hostLeft(final, () => localGame.quitToMenu());
  });
  link.onReconnecting = () => overlay.reconnecting(() => localGame.quitToMenu());
  link.onOpen = () => remote && uiEvents.onStateChange(remote.state);
  setView(remote);
  if (!link.peerPresent) overlay.hostLeft(false, () => localGame.quitToMenu());
}

/* ---------- HUD buttons ---------- */

function updateDynamiteBtn(): void {
  const twoLocal = view.players.length === 2 && !view.isOnline;
  document.body.classList.toggle('two-local', twoLocal);
  const show = view.state === 'playing' && view.buffs.dynamite > 0;
  for (const [btn, visible] of [
    [dynamiteBtn, show],
    [dynamiteBtn2, show && twoLocal],
  ] as const) {
    btn.classList.toggle('hidden', !visible);
    btn.innerHTML = `${ITEM_ICON.dynamite} <span>${view.buffs.dynamite}</span>`;
    btn.title = t('hud.dynamite');
    btn.setAttribute('aria-label', t('hud.dynamite'));
  }
}

/** Which player a tap at this client position controls. */
function playerForPointer(clientX: number): number {
  if (view.players.length < 2) return 0;
  if (view.isOnline) return view.localPlayer;
  return renderer.toWorld(clientX, 0).x < WORLD_W / 2 ? 0 : 1;
}

/* ---------- Input ---------- */

canvas.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  sfx.unlock();
  view.primary(playerForPointer(ev.clientX));
});
pauseBtn.addEventListener('click', () => view.pause());
dynamiteBtn.addEventListener('click', () => view.useDynamite(view.isOnline ? view.localPlayer : 0));
dynamiteBtn2.addEventListener('click', () => view.useDynamite(1));

window.addEventListener('keydown', (ev) => {
  if (ev.repeat) return;
  const tag = (ev.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const twoLocal = view.players.length === 2 && !view.isOnline;
  const me = view.isOnline ? view.localPlayer : 0;
  // Two players on one keyboard: P1 = S/A/Space fire, W dynamite; P2 = ↓/→ fire, ↑ dynamite.
  const fireKeys: Record<string, number> = twoLocal
    ? { Space: 0, KeyS: 0, KeyA: 0, Enter: 0, NumpadEnter: 0, ArrowDown: 1, ArrowRight: 1 }
    : { Space: me, ArrowDown: me, Enter: me, NumpadEnter: me };
  const dynKeys: Record<string, number> = twoLocal ? { KeyW: 0, ArrowUp: 1 } : { ArrowUp: me, KeyD: me };
  if (ev.code in fireKeys) {
    if (view.state === 'playing' || view.state === 'levelIntro') {
      ev.preventDefault();
      sfx.unlock();
      view.primary(fireKeys[ev.code]);
    } else if (view.state === 'paused' && ev.code !== 'Enter') {
      view.resume();
    }
    return;
  }
  if (ev.code in dynKeys) {
    if (view.state === 'playing') {
      ev.preventDefault();
      view.useDynamite(dynKeys[ev.code]);
    }
    return;
  }
  switch (ev.code) {
    case 'KeyP':
    case 'Escape':
      if (view.state === 'playing') view.pause();
      else if (view.state === 'paused') view.resume();
      break;
    case 'KeyM':
      sfx.unlock();
      sfx.setMuted(!sfx.muted);
      overlay.toast(`${t('menu.sound')}: ${sfx.muted ? t('menu.off') : t('menu.on')}`);
      break;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) view.pause();
});
window.addEventListener('blur', () => view.pause());

/* ---------- Resize ---------- */

const ro = new ResizeObserver(() => renderer.resize());
ro.observe(canvas);
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 150));

/* ---------- Language ---------- */

onLangChange(() => {
  overlay.refresh();
  updateDynamiteBtn();
});
document.title = t('app.title');
pauseBtn.title = t('hud.pause');
pauseBtn.setAttribute('aria-label', t('hud.pause'));
pauseBtn.innerHTML = PAUSE_ICON;

/* ---------- Boot ---------- */

const room = location.hash.match(/^#room=([A-Za-z2-9]{6})$/);
if (room) {
  overlay.pendingSave = readSaveFromStorage();
  void startJoining((room[1] as string).toUpperCase());
} else {
  const hashSave = readSaveFromHash();
  if (location.hash.startsWith('#g=') && !hashSave) {
    overlay.toast(t('menu.badLink'));
    history.replaceState(null, '', location.pathname + location.search);
    clearStoredSave();
  }
  // A stale bookmark or old shared link must not hide newer progress kept on this device.
  const picked = pickSave(hashSave, readSaveFromStorage());
  overlay.pendingSave = picked.primary;
  overlay.alternativeSave = picked.alternative;
  if (picked.primary && hashSave && picked.primary !== hashSave) persistSave(picked.primary);
  overlay.menu();
}

if (import.meta.env.DEV) {
  const w = window as unknown as { __game: Game; __view: () => GameView; __renderer: Renderer };
  w.__game = localGame;
  w.__renderer = renderer;
  w.__view = () => view;
}

// Offline support / installability. Updates are applied on the next launch.
registerSW({ immediate: true });

/* ---------- Loop ---------- */

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  view.frame(dt);
  host?.frame(dt);
  const h = view.players[view.isOnline ? view.localPlayer : 0]?.hook;
  const reeling = view.state === 'playing' && view.players.some((p) => p.hook.phase === 'retract');
  sfx.reel(reeling, h?.grabbed ? 300 / (0.5 + ITEM_SPECS[h.grabbed.kind].weight) : 700);
  renderer.draw(view, dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
