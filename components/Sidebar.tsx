'use client';

import { useMemo, useState } from 'react';
import type { Agent, HubEvent, StatusSnapshot } from '@/lib/types';
import { STATUS_META } from '@/lib/types';
import { Avatar, Icon, agoOf, cx } from './ui';

interface Props {
  agents: Agent[];
  statuses: Record<string, StatusSnapshot>;
  events: Record<string, HubEvent[]>;
  unread: Record<string, number>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  filter: 'all' | 'running';
}

export function Sidebar({ agents, statuses, events, unread, activeId, onSelect, onCreate, filter }: Props) {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      const status = statuses[a.id]?.status ?? 'stopped';
      if (filter === 'running' && ['stopped', 'error'].includes(status)) return false;
      if (!q) return true;
      return a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q);
    });
  }, [agents, statuses, query, filter]);

  return (
    <aside className="flex w-[330px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-2 px-4 pb-3 pt-5">
        <div className="relative flex-1">
          <Icon name="search" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-soft)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents"
            className="w-full rounded-full bg-[var(--surface-3)] py-2.5 pl-9 pr-3 text-[13.5px] outline-none placeholder:text-[var(--text-soft)] focus:ring-2 focus:ring-[var(--accent)]/25"
          />
        </div>
        <button
          type="button"
          onClick={onCreate}
          title="New agent"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-white transition hover:brightness-110"
        >
          <Icon name="plus" className="h-5 w-5" />
        </button>
      </div>

      <div className="scroll-thin flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {visible.length === 0 && (
          <p className="px-4 py-8 text-center text-[13px] text-[var(--text-soft)]">
            {agents.length ? 'No agents match.' : 'No agents yet - create one.'}
          </p>
        )}

        {visible.map((agent) => {
          const status = statuses[agent.id]?.status ?? 'stopped';
          const activity = statuses[agent.id]?.activity;
          const list = events[agent.id] ?? [];
          const last = [...list].reverse().find((e) => ['user', 'assistant', 'error', 'permission'].includes(e.kind));
          const count = unread[agent.id] ?? 0;
          const active = agent.id === activeId;
          const needsPermission = status === 'waiting_for_permission';

          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelect(agent.id)}
              className={cx(
                'flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition',
                active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-2)]',
              )}
            >
              <Avatar label={agent.name} accent={agent.accent} size={44} status={status} />

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cx('truncate text-[14px] font-semibold', active && 'text-[var(--accent-ink)]')}>
                    {agent.name}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-[var(--text-soft)]">
                    {last ? agoOf(last.ts) : ''}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span
                    className={cx(
                      'truncate text-[12.5px]',
                      needsPermission
                        ? 'font-semibold text-[var(--alert)]'
                        : active
                          ? 'text-[var(--accent-ink)]'
                          : 'text-[var(--text-muted)]',
                    )}
                  >
                    {needsPermission
                      ? 'Permission requested'
                      : (activity ??
                        (last
                          ? `${last.kind === 'user' ? 'You: ' : ''}${(last.text ?? last.title ?? '').replace(/\s+/g, ' ').slice(0, 42)}`
                          : STATUS_META[status].label))}
                  </span>
                  {count > 0 && (
                    <span className="ml-auto grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[var(--alert)] px-1.5 text-[11px] font-bold text-white">
                      {count}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
