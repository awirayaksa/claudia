/**
 * One WebSocket to /api/ws for live updates, opened when the first topic is
 * subscribed and closed when the last one goes. Reconnects with backoff and
 * subscribes again; the server checks access per topic.
 */
import { useEffect, useRef } from 'react';

type Handler = (event: any) => void;

class LiveSocket {
  private socket: WebSocket | null = null;
  private topics = new Map<string, Set<Handler>>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  subscribe(topic: string, handler: Handler): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      this.topics.set(topic, (set = new Set()));
      this.send({ type: 'subscribe', topic });
    }
    set.add(handler);
    this.ensure();
    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.topics.delete(topic);
        this.send({ type: 'unsubscribe', topic });
      }
      if (this.topics.size === 0) this.close();
    };
  }

  private send(msg: object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private ensure() {
    if (this.socket || this.timer) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      for (const topic of this.topics.keys()) socket.send(JSON.stringify({ type: 'subscribe', topic }));
    };
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (msg.topic && msg.event) this.topics.get(msg.topic)?.forEach((h) => h(msg.event));
      } catch {
        /* not ours */
      }
    };
    socket.onclose = () => {
      this.socket = null;
      if (this.topics.size === 0) return;
      // Back off up to 30 s
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.ensure();
      }, delay);
    };
  }

  private close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }
}

const live = new LiveSocket();

/** Call `handler` with each event of `topic` (null: nothing) while mounted. */
export function useTopic(topic: string | null, handler: Handler): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!topic || typeof WebSocket === 'undefined') return;
    return live.subscribe(topic, (e) => ref.current(e));
  }, [topic]);
}
