/**
 * Live updates over a WebSocket (/api/ws): the browser subscribes to topics
 * ("kb:<id>") and gets their events. Subscribing checks access; the
 * connection is authenticated by the session cookie and only accepted from
 * this app's own origin (browsers send cookies with cross-site WebSocket
 * handshakes, so the Origin check is the CSRF protection here).
 *
 * In-process for now; Phase 6 fans events out across instances via Redis.
 */
import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { ServerContext } from '../context';
import type { AuthUser } from '../auth/sessions';

export type TopicGuard = (user: AuthUser, id: string) => Promise<boolean>;

const PING_MS = 25_000;

export class EventHub {
  private subs = new Map<string, Set<WebSocket>>();
  private guards = new Map<string, TopicGuard>();

  /** Who may subscribe to "<kind>:<id>". */
  guard(kind: string, check: TopicGuard): void {
    this.guards.set(kind, check);
  }

  async subscribe(socket: WebSocket, user: AuthUser, topic: string): Promise<boolean> {
    const [kind, id] = topic.split(':');
    const check = this.guards.get(kind);
    if (!check || !id || !(await check(user, id).catch(() => false))) return false;
    let set = this.subs.get(topic);
    if (!set) this.subs.set(topic, (set = new Set()));
    set.add(socket);
    return true;
  }

  unsubscribe(socket: WebSocket, topic?: string): void {
    for (const [t, set] of this.subs) {
      if (topic && t !== topic) continue;
      set.delete(socket);
      if (set.size === 0) this.subs.delete(t);
    }
  }

  publish(topic: string, event: object): void {
    const set = this.subs.get(topic);
    if (!set) return;
    const data = JSON.stringify({ topic, event });
    for (const socket of set) if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

function sameOrigin(origin: string | undefined, host: string | undefined, publicUrl?: string): boolean {
  if (!origin || !host) return false;
  try {
    const o = new URL(origin);
    if (publicUrl && o.origin === new URL(publicUrl).origin) return true;
    return o.host === host;
  } catch {
    return false;
  }
}

export async function registerWebSocket(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const user = req.user;
    if (!user || user.role === 'pending' || !sameOrigin(req.headers.origin, req.headers.host, ctx.config.CLAUDIA_PUBLIC_URL)) {
      socket.close(4401, user ? 'Forbidden' : 'Sign in first');
      return;
    }
    const ping = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), PING_MS);
    ping.unref?.();
    socket.on('message', (raw) => {
      let msg: { type?: string; topic?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof msg.topic !== 'string' || msg.topic.length > 200) return;
      if (msg.type === 'subscribe') {
        void ctx.events.subscribe(socket, user, msg.topic).then((ok) => socket.send(JSON.stringify({ type: ok ? 'subscribed' : 'denied', topic: msg.topic })));
      } else if (msg.type === 'unsubscribe') {
        ctx.events.unsubscribe(socket, msg.topic);
      }
    });
    socket.on('close', () => {
      clearInterval(ping);
      ctx.events.unsubscribe(socket);
    });
  });
}
