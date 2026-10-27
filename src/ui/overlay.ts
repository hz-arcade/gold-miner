import type { GameView } from '../game/Game';
import { type SaveState, shareUrl } from '../game/save';
import { formatMoney, getLang, LANG_NAMES, LANGS, setLang, t, type Lang, type StringKey } from '../i18n';

import { ITEM_ICON } from './icons';
import qrcode from 'qrcode-generator';

export interface OverlayActions {
  newGame(players: 1 | 2): void;
  continueGame(save: SaveState): void;
  createOnline(): void;
  joinWithCode(): void;
  toggleSound(): boolean;
  isMuted(): boolean;
  isTouch(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const GLOBE_ICON =
  '<svg class="globe" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><ellipse cx="12" cy="12" rx="4" ry="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 12h19M4 7.5h16M4 16.5h16" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

const BACK_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** DOM screens layered over the canvas. Re-rendered on language change. */
export class Overlay {
  private root: HTMLElement;
  private toastEl: HTMLElement;
  private toastTimer = 0;
  private current: (() => void) | null = null;
  pendingSave: SaveState | null = null;
  /** A different game found in local storage when the page was opened from a save link. */
  alternativeSave: SaveState | null = null;

  constructor(private game: GameView, private actions: OverlayActions) {
    this.root = document.getElementById('overlay')!;
    this.toastEl = document.getElementById('toast')!;
    document.getElementById('orientation')!.textContent = t('orientation.hint');
  }

  /** Point the overlays at a different view (local game vs. remote mirror). */
  setGame(g: GameView): void {
    this.game = g;
  }

  /** Re-render the current screen (used after language switches). */
  refresh(): void {
    document.title = t('app.title');
    document.getElementById('orientation')!.textContent = t('orientation.hint');
    this.current?.();
  }

  hide(): void {
    this.current = null;
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
  }

  private show(build: (panel: HTMLElement) => void, transparent = false, onBackdrop?: () => void): void {
    this.current = () => this.show(build, transparent, onBackdrop);
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');
    this.root.classList.toggle('transparent', transparent);
    this.root.onpointerdown = onBackdrop
      ? (ev) => {
          // Tap anywhere that is not a control counts as the primary action.
          if ((ev.target as HTMLElement).closest('button, input, a')) return;
          ev.preventDefault();
          onBackdrop();
        }
      : null;
    const panel = el('div', 'panel');
    build(panel);
    this.root.appendChild(panel);
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  /** One button showing the current language; tapping it drops down the list of languages. */
  private langRow(): HTMLElement {
    const wrap = el('div', 'lang-menu');
    const current = getLang();
    const toggle = el('button', 'btn secondary lang-btn');
    toggle.type = 'button';
    toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `${GLOBE_ICON}<span>${LANG_NAMES[current]}</span><span class="caret" aria-hidden="true"></span>`;
    const list = el('div', 'lang-list');
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    for (const lang of LANGS) {
      const item = el('button', `lang-item${lang === current ? ' active' : ''}`, LANG_NAMES[lang]);
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(lang === current));
      item.lang = lang;
      item.addEventListener('click', () => {
        setLang(lang as Lang);
        this.refresh();
      });
      list.appendChild(item);
    }
    const close = () => {
      list.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onOutside, true);
    };
    const onOutside = (ev: Event) => {
      if (!wrap.contains(ev.target as Node)) close();
    };
    toggle.addEventListener('click', () => {
      if (!list.hidden) return close();
      list.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onOutside, true);
    });
    wrap.append(toggle, list);
    return wrap;
  }

  private soundButton(): HTMLButtonElement {
    const label = () => `${t('menu.sound')}: ${this.actions.isMuted() ? t('menu.off') : t('menu.on')}`;
    const b = button(label(), 'secondary', () => {
      this.actions.toggleSound();
      b.textContent = label();
    });
    return b;
  }

  menu(): void {
    this.show((p) => {
      p.appendChild(el('h1', undefined, t('app.title')));
      const s = this.pendingSave;
      if (s) {
        p.appendChild(button(s.players === 2 ? t('menu.continueCoop') : t('menu.continue'), 'primary', () => this.actions.continueGame(s)));
        p.appendChild(el('p', 'muted', t('menu.continueInfo', { level: s.level, money: s.money })));
      }
      const alt = this.alternativeSave;
      if (alt) {
        p.appendChild(button(t('menu.continueOther'), 'secondary', () => this.actions.continueGame(alt)));
        p.appendChild(el('p', 'muted', t('menu.continueInfo', { level: alt.level, money: alt.money })));
      }
      p.appendChild(button(t('menu.newGame'), s ? '' : 'primary', () => this.actions.newGame(1)));
      p.appendChild(el('h2', undefined, t('menu.twoPlayers'))).style.marginTop = '16px';
      const two = el('div', 'row');
      two.appendChild(button(t('menu.localCoop'), 'secondary', () => this.actions.newGame(2)));
      two.appendChild(button(t('menu.createOnline'), 'secondary', () => this.actions.createOnline()));
      two.appendChild(button(t('menu.joinCode'), 'secondary', () => this.actions.joinWithCode()));
      p.appendChild(two);
      const how = el('p', 'muted');
      how.textContent = this.actions.isTouch() ? t('menu.howToMobile') : t('menu.howToDesktop');
      p.appendChild(el('h2', undefined, t('menu.howTo'))).style.marginTop = '16px';
      p.appendChild(how);
      p.appendChild(el('p', 'muted', t('menu.localCoopHint')));
      p.appendChild(el('p', 'muted', t('menu.saveHint')));
      const row = el('div', 'row');
      row.appendChild(this.soundButton());
      p.appendChild(row);
      p.appendChild(this.langRow());
      p.appendChild(this.arcadeLink());
    });
  }

  /** Plain link back to the HZ Arcade catalog at the site root (main menu only). */
  private arcadeLink(): HTMLElement {
    const wrap = el('div', 'arcade-row');
    const a = el('a', 'arcade-link');
    a.href = '/';
    a.innerHTML = BACK_ICON;
    a.appendChild(el('span', undefined, t('menu.arcade')));
    // Keep taps/keys on the link from reaching any game input handlers.
    a.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    a.addEventListener('keydown', (ev) => ev.stopPropagation());
    wrap.appendChild(a);
    return wrap;
  }

  levelIntro(): void {
    const g = this.game;
    this.show((p) => {
      p.appendChild(el('h1', undefined, t('level.start', { level: g.save.level })));
      p.appendChild(el('p', undefined, t('level.goal', { goal: g.level.goal.toLocaleString('en-US') })));
      p.appendChild(el('p', 'muted', t('level.earn', { money: g.money.toLocaleString('en-US'), amount: Math.max(0, g.level.goal - g.money).toLocaleString('en-US') })));
      if (g.isOnline) p.appendChild(el('p', 'muted', t('online.youAre', { n: g.localPlayer + 1 })));
      if (g.save.inventory.length) {
        const row = el('div', 'row');
        for (const id of g.save.inventory) {
          const chip = el('span', 'chip');
          chip.innerHTML = `${ITEM_ICON[id]} <span>${t(`item.${id}` as StringKey)}</span>`;
          row.appendChild(chip);
        }
        p.appendChild(row);
      }
      p.appendChild(button(t('level.tapToStart'), 'primary', () => g.primary()));
    }, true, () => g.primary());
  }

  paused(): void {
    const g = this.game;
    this.show((p) => {
      p.appendChild(el('h2', undefined, t('pause.title')));
      p.appendChild(button(t('pause.resume'), 'primary', () => g.resume()));
      const row = el('div', 'row');
      row.appendChild(button(t('pause.restartLevel'), 'secondary', () => g.restartLevel()));
      row.appendChild(button(t('pause.quit'), 'secondary', () => g.quitToMenu()));
      row.appendChild(this.soundButton());
      p.appendChild(row);
      if (g.isHost) p.appendChild(this.saveLinkBox());
      p.appendChild(this.langRow());
    });
  }

  private saveLinkBox(): HTMLElement {
    const wrap = el('div');
    wrap.appendChild(el('p', 'muted', t('pause.saveLink')));
    const box = el('div', 'link-box');
    const input = el('input');
    input.readOnly = true;
    input.value = shareUrl(this.game.save);
    input.addEventListener('focus', () => input.select());
    const copy = button(t('pause.copy'), 'secondary', async () => {
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      this.toast(t('pause.copied'));
    });
    copy.style.margin = '0';
    box.append(input, copy);
    wrap.appendChild(box);
    return wrap;
  }

  levelResult(): void {
    const g = this.game;
    this.show((p) => {
      p.appendChild(el('h1', undefined, t('level.cleared', { level: g.level.level })));
      p.appendChild(el('div', 'big-money', formatMoney(g.save.money)));
      if (g.isHost) p.appendChild(button(t('level.next'), 'primary', () => g.openShop()));
      else p.appendChild(el('p', 'muted', t('online.waitingHostNext')));
    });
  }

  gameOver(): void {
    const g = this.game;
    this.show((p) => {
      p.appendChild(el('h1', undefined, t('gameover.title')));
      p.appendChild(el('p', undefined, t('level.failed')));
      p.appendChild(el('p', undefined, t('gameover.summary', { level: g.level.level, money: g.money.toLocaleString('en-US') })));
      p.appendChild(button(t('level.retry'), 'primary', () => g.restartLevel()));
      const row = el('div', 'row');
      if (!g.isOnline) row.appendChild(button(t('menu.newGame'), 'secondary', () => this.actions.newGame(g.save.players)));
      row.appendChild(button(t('pause.quit'), 'secondary', () => g.quitToMenu()));
      p.appendChild(row);
    });
  }

  shop(onBuy: () => void): void {
    const g = this.game;
    this.show((p) => {
      p.appendChild(el('h1', undefined, t('shop.title')));
      p.appendChild(el('p', 'muted', t('shop.subtitle')));
      const money = el('div', 'big-money', formatMoney(g.save.money));
      p.appendChild(money);
      const list = el('div', 'shop-list');
      const rows: (() => void)[] = [];
      for (const offer of g.offers) {
        const item = el('div', 'shop-item');
        const icon = el('div', 'icon');
        icon.innerHTML = ITEM_ICON[offer.id];
        item.appendChild(icon);
        const info = el('div');
        info.appendChild(el('div', 'name', t(`item.${offer.id}` as StringKey)));
        info.appendChild(el('div', 'desc', t(`item.${offer.id}.desc` as StringKey)));
        item.appendChild(info);
        const right = el('div');
        right.appendChild(el('div', 'price', formatMoney(offer.price)));
        const buy = button(t('shop.buy'), '', () => {
          if (g.buy(offer)) {
            onBuy();
            money.textContent = formatMoney(g.save.money);
            rows.forEach((r) => r());
          }
        });
        right.appendChild(buy);
        item.appendChild(right);
        list.appendChild(item);
        const update = () => {
          const owned = offer.id !== 'dynamite' && g.owns(offer.id);
          const dynCount = offer.id === 'dynamite' ? g.save.inventory.filter((i) => i === 'dynamite').length : 0;
          buy.disabled = !g.canBuy(offer);
          buy.textContent = owned ? t('shop.owned') : dynCount ? `${t('shop.buy')} (${dynCount})` : g.save.money < offer.price ? t('shop.tooExpensive') : t('shop.buy');
        };
        rows.push(update);
        update();
      }
      p.appendChild(list);
      if (g.isHost) p.appendChild(button(t('shop.next'), 'primary', () => g.nextLevel()));
      else p.appendChild(el('p', 'muted', t('online.waitingHostNext')));
    });
  }

  /* ---------- Online co-op screens ---------- */

  private qr(text: string): HTMLElement {
    const wrap = el('div', 'qr');
    try {
      const q = qrcode(0, 'M');
      q.addData(text, 'Byte');
      q.make();
      wrap.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      wrap.textContent = '';
    }
    return wrap;
  }

  private async share(url: string): Promise<void> {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: t('app.title'), url });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    await this.copy(url);
  }

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(t('pause.copied'));
    } catch {
      /* ignore */
    }
  }

  /** Host lobby: shows the code and link until the guest arrives. */
  lobby(opts: {
    status: 'preparing' | 'waiting' | 'failed' | 'notConfigured';
    code?: string;
    link?: string;
    onRetry: () => void;
    onCancel: () => void;
    resume?: { level: number; money: number; enabled: boolean; toggle: () => void };
  }): void {
    this.show((p) => {
      p.appendChild(el('h2', undefined, t('online.title')));
      if (opts.status === 'preparing') p.appendChild(el('p', undefined, t('online.preparing')));
      if (opts.status === 'failed' || opts.status === 'notConfigured') {
        p.appendChild(el('p', undefined, t(opts.status === 'failed' ? 'online.failed' : 'online.notConfigured')));
        if (opts.status === 'failed') p.appendChild(button(t('online.tryAgain'), 'primary', opts.onRetry));
      }
      if (opts.status === 'waiting' && opts.code && opts.link) {
        p.dataset.code = opts.code;
        p.dataset.link = opts.link;
        p.appendChild(el('p', 'muted', t('online.roomCode')));
        p.appendChild(el('div', 'room-code', opts.code));
        p.appendChild(el('p', undefined, t('online.inviteReady')));
        const row = el('div', 'row');
        row.appendChild(button(t('online.share'), 'primary', () => void this.share(opts.link!)));
        row.appendChild(button(t('online.copy'), 'secondary', () => void this.copy(opts.link!)));
        p.appendChild(row);
        p.appendChild(this.qr(opts.link));
        p.appendChild(el('p', 'muted', t('online.qrHint')));
        p.appendChild(el('p', undefined, t('online.waitingPeer')));
        if (opts.resume) {
          const r = opts.resume;
          p.appendChild(
            button(r.enabled ? t('online.continueFrom', { level: r.level, money: r.money }) : t('online.startFresh'), 'secondary', () => {
              r.toggle();
              this.refresh();
            }),
          );
        }
      }
      p.appendChild(button(t('pause.quit'), 'secondary', opts.onCancel));
    });
  }

  /** Guest: type a room code. */
  enterCode(onCode: (code: string) => void, onCancel: () => void): void {
    this.show((p) => {
      p.appendChild(el('h2', undefined, t('online.title')));
      p.appendChild(el('p', undefined, t('online.enterCode')));
      const box = el('div', 'link-box');
      const input = el('input');
      input.className = 'code-input';
      input.maxLength = 6;
      input.autocapitalize = 'characters';
      input.autocomplete = 'off';
      input.spellcheck = false;
      const go = button(t('online.join'), 'primary', () => onCode(input.value));
      go.style.margin = '0';
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') onCode(input.value);
      });
      box.append(input, go);
      p.appendChild(box);
      p.appendChild(button(t('pause.quit'), 'secondary', onCancel));
      setTimeout(() => input.focus(), 50);
    });
  }

  /** Guest: connection progress / errors. */
  join(opts: { status: 'joining' | 'noRoom' | 'roomFull' | 'failed' | 'notConfigured'; onRetry: () => void; onCancel: () => void }): void {
    this.show((p) => {
      p.appendChild(el('h2', undefined, t('online.title')));
      if (opts.status === 'joining') p.appendChild(el('p', undefined, t('online.joining')));
      else {
        p.appendChild(el('p', undefined, t(`online.${opts.status}` as StringKey)));
        if (opts.status === 'failed') p.appendChild(button(t('online.tryAgain'), 'primary', opts.onRetry));
      }
      p.appendChild(button(t('pause.quit'), 'secondary', opts.onCancel));
    });
  }

  /** Host: the guest dropped; the room stays open for a rejoin. */
  peerLeft(onAlone: () => void, onQuit: () => void): void {
    this.show((p) => {
      p.appendChild(el('h2', undefined, t('online.peerLeft')));
      p.appendChild(el('p', undefined, t('online.peerWaiting')));
      const row = el('div', 'row');
      row.appendChild(button(t('online.continueAlone'), 'secondary', onAlone));
      row.appendChild(button(t('pause.quit'), 'secondary', onQuit));
      p.appendChild(row);
    });
  }

  /** Guest: the host dropped (maybe temporarily) or left for good. */
  hostLeft(final: boolean, onQuit: () => void): void {
    this.show((p) => {
      p.appendChild(el('h2', undefined, t(final ? 'online.hostGone' : 'online.hostLeft')));
      if (!final) p.appendChild(el('p', undefined, t('online.hostWaiting')));
      p.appendChild(button(t('pause.quit'), 'primary', onQuit));
    });
  }

  /** Either side: our own socket is reconnecting. */
  reconnecting(onQuit: () => void): void {
    this.show((p) => {
      p.appendChild(el('h2', undefined, t('online.title')));
      p.appendChild(el('p', undefined, t('online.reconnecting')));
      p.appendChild(button(t('pause.quit'), 'secondary', onQuit));
    });
  }
}
