/**
 * WebSocket connection to the Cloudflare relay for one room. Reconnects by itself for a
 * while when the network hiccups (phone locked, Wi-Fi ↔ cellular), so a game survives
 * short drops without either player doing anything.
 */
export type RelayRole = 'host' | 'guest';

export function relayUrl(): string {
  const raw = (import.meta.env.VITE_RELAY_URL as string | undefined)?.trim();
  if (raw) return raw.replace(/\/$/, '');
  return import.meta.env.DEV ? 'http://localhost:8787' : '';
}

export function relayConfigured(): boolean {
  return relayUrl() !== '';
}

export function roomLink(code: string): string {
  return `${location.origin}${location.pathname}#room=${code}`;
}

export async function createRoom(): Promise<string> {
  const res = await fetch(`${relayUrl()}/rooms`, { method: 'POST' });
  if (!res.ok) throw new Error('create-failed');
  const data = (await res.json()) as { code?: string };
  if (!data.code) throw new Error('create-failed');
  return data.code;
}

export async function roomInfo(code: string): Promise<{ exists: boolean; host: boolean; guest: boolean }> {
  const res = await fetch(`${relayUrl()}/rooms/${code}`);
  if (res.status === 404) return { exists: false, host: false, guest: false };
  if (!res.ok) throw new Error('info-failed');
  return (await res.json()) as { exists: boolean; host: boolean; guest: boolean };
}

const HEARTBEAT_MS = 25_000;
/** Give up reconnecting after this long without a connection. */
const RECONNECT_WINDOW_MS = 90_000;

export class RelayLink {
  private ws: WebSocket | null = null;
  private closed = false;
  private heartbeat = 0;
  private reconnectTimer = 0;
  private attempts = 0;
  private downSince = 0;
  /** Whether the other player is currently connected to the room. */
  peerPresent = false;

  onOpen: (() => void) | null = null;
  onMessageHandler: ((msg: unknown) => void) | null = null;
  onSnapshotHandler: ((msg: unknown) => void) | null = null;
  onPeerJoined: (() => void) | null = null;
  onPeerLeft: (() => void) | null = null;
  /** Fired once, when the link is finally given up (explicit close or reconnect window over). */
  onCloseHandler: ((reason: 'closed' | 'failed' | 'idle') => void) | null = null;
  /**
   * The relay closed the room after its no-input timeout. Fired right after onCloseHandler,
   * so its dialog replaces the generic "disconnected" one.
   */
  onIdle: (() => void) | null = null;
  /** Reconnect attempt in progress (UI can show "reconnecting…"). */
  onReconnecting: ((attempt: number) => void) | null = null;

  constructor(
    readonly role: RelayRole,
    readonly code: string,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${relayUrl().replace(/^http/, 'ws')}/rooms/${this.code}/ws?role=${this.role}`;
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        reject(new Error('failed'));
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.attempts = 0;
        this.downSince = 0;
        clearInterval(this.heartbeat);
        this.heartbeat = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, HEARTBEAT_MS);
        settled = true;
        this.onOpen?.();
        resolve();
      };
      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        let m: unknown;
        try {
          m = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        const tag = (m as { t?: string; k?: string } | null)?.t;
        if (tag === 'relay') {
          const k = (m as { k: string; peer?: boolean }).k;
          if (k === 'welcome') {
            const had = this.peerPresent;
            this.peerPresent = !!(m as { peer?: boolean }).peer;
            if (this.peerPresent && !had) this.onPeerJoined?.();
          } else if (k === 'peer-joined') {
            this.peerPresent = true;
            this.onPeerJoined?.();
          } else if (k === 'peer-left') {
            this.peerPresent = false;
            this.onPeerLeft?.();
          }
          return;
        }
        if (tag === 's') this.onSnapshotHandler?.(m);
        else this.onMessageHandler?.(m);
      };
      ws.onclose = (ev) => {
        clearInterval(this.heartbeat);
        if (this.ws !== ws) return;
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error(ev.code === 1006 ? 'failed' : 'closed'));
          if (!this.closed && ev.code !== 4000) this.scheduleReconnect();
          return;
        }
        if (this.closed) return;
        if (ev.code === 4000) {
          // Replaced by another connection of the same role (we reconnected elsewhere).
          this.finish('closed');
          return;
        }
        if (ev.code === 4001) {
          // The relay shut the room down after a long stretch without input; it is gone.
          this.finish('idle');
          return;
        }
        this.scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (!this.downSince) this.downSince = Date.now();
    if (Date.now() - this.downSince > RECONNECT_WINDOW_MS) {
      this.finish('failed');
      return;
    }
    this.attempts += 1;
    this.onReconnecting?.(this.attempts);
    const delay = Math.min(8000, 500 * 2 ** Math.min(4, this.attempts - 1));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      if (this.closed) return;
      this.connect().catch(() => {
        /* scheduleReconnect already queued by onclose */
      });
    }, delay);
  }

  private finish(reason: 'closed' | 'failed' | 'idle'): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnectTimer);
    this.onCloseHandler?.(reason);
    if (reason === 'idle') this.onIdle?.();
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Snapshots go over the same socket; the name is kept for the host/guest sessions. */
  sendSnapshot(msg: unknown): void {
    this.send(msg);
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.finish('closed');
    try {
      ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
  }
}
