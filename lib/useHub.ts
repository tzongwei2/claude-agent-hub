'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, HubEvent, StatusSnapshot, UsageWindow } from './types';

type Conn = 'connecting' | 'open' | 'closed';

/**
 * One WebSocket for the whole hub. Every agent streams over it concurrently,
 * so switching agents is instant (no reconnect, no refetch) and a busy agent
 * never blocks the UI of another.
 */
export function useHub() {
  const [conn, setConn] = useState<Conn>('connecting');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [statuses, setStatuses] = useState<Record<string, StatusSnapshot>>({});
  const [events, setEvents] = useState<Record<string, HubEvent[]>>({});
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageWindow | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const activeRef = useRef<string | null>(null);
  const loaded = useRef<Set<string>>(new Set());
  const retry = useRef(0);

  const send = useCallback((msg: Record<string, unknown>) => {
    const socket = ws.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    else setToast('Not connected to the hub - reconnecting…');
  }, []);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (closed) return;
      setConn('connecting');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${location.host}/ws`);
      ws.current = socket;

      socket.onopen = () => {
        retry.current = 0;
        setConn('open');
        // Re-request history for whatever is on screen after a reconnect.
        loaded.current.clear();
        if (activeRef.current) socket.send(JSON.stringify({ t: 'history', agentId: activeRef.current }));
      };

      socket.onclose = () => {
        setConn('closed');
        if (closed) return;
        retry.current = Math.min(retry.current + 1, 6);
        timer = setTimeout(connect, 400 * retry.current);
      };

      socket.onerror = () => socket.close();

      socket.onmessage = (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.data);
        } catch {
          return;
        }

        switch (msg.t) {
          case 'hello':
          case 'agents': {
            setAgents(msg.agents);
            setStatuses(Object.fromEntries((msg.statuses ?? []).map((s: StatusSnapshot) => [s.agentId, s])));
            if (msg.usage) setUsage(msg.usage);
            break;
          }
          case 'usage':
          case 'ratelimit': {
            if (msg.usage) setUsage(msg.usage);
            break;
          }
          case 'history': {
            loaded.current.add(msg.agentId);
            setEvents((prev) => ({ ...prev, [msg.agentId]: msg.events }));
            break;
          }
          case 'event': {
            const ev: HubEvent = msg.event;
            setEvents((prev) => {
              const list = prev[msg.agentId] ?? [];
              const idx = list.findIndex((e) => e.id === ev.id);
              const next = idx >= 0 ? list.map((e, i) => (i === idx ? ev : e)) : [...list, ev];
              return { ...prev, [msg.agentId]: next };
            });
            if (ev.kind === 'assistant' || ev.kind === 'tool_use') {
              setStreaming((prev) => ({ ...prev, [msg.agentId]: '' }));
            }
            if (msg.agentId !== activeRef.current && ['assistant', 'permission', 'error'].includes(ev.kind)) {
              setUnread((prev) => ({ ...prev, [msg.agentId]: (prev[msg.agentId] ?? 0) + 1 }));
            }
            break;
          }
          case 'delta': {
            setStreaming((prev) => ({ ...prev, [msg.agentId]: (prev[msg.agentId] ?? '') + msg.text }));
            break;
          }
          case 'delta-end': {
            setStreaming((prev) => ({ ...prev, [msg.agentId]: '' }));
            break;
          }
          case 'status': {
            const s: StatusSnapshot = msg.status;
            setStatuses((prev) => ({ ...prev, [s.agentId]: s }));
            break;
          }
          case 'notify': {
            if (msg.agentId !== activeRef.current) {
              setUnread((prev) => ({ ...prev, [msg.agentId]: (prev[msg.agentId] ?? 0) + 1 }));
            }
            break;
          }
          case 'error': {
            setToast(msg.message);
            break;
          }
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const selectAgent = useCallback(
    (id: string) => {
      activeRef.current = id;
      setUnread((prev) => ({ ...prev, [id]: 0 }));
      if (!loaded.current.has(id)) send({ t: 'history', agentId: id });
    },
    [send],
  );

  const refreshAgents = useCallback(() => send({ t: 'agents' }), [send]);

  const api = useMemo(
    () => ({
      sendMessage: (agentId: string, text: string) => send({ t: 'send', agentId, text }),
      respondPermission: (agentId: string, requestId: string, behavior: 'allow' | 'deny') =>
        send({ t: 'permission', agentId, requestId, behavior }),
      start: (agentId: string) => send({ t: 'start', agentId }),
      stop: (agentId: string) => send({ t: 'stop', agentId }),
      restart: (agentId: string) => send({ t: 'restart', agentId }),
      interrupt: (agentId: string) => send({ t: 'interrupt', agentId }),
      clear: (agentId: string) => send({ t: 'clear', agentId }),
    }),
    [send],
  );

  return { conn, agents, statuses, events, streaming, unread, usage, toast, setToast, selectAgent, refreshAgents, ...api };
}
