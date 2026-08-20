'use client';

import { useEffect, useMemo, useState } from 'react';
import { useHub } from '@/lib/useHub';
import type { Agent, StatusSnapshot } from '@/lib/types';
import { Chat } from '@/components/Chat';
import { Sidebar } from '@/components/Sidebar';
import { AgentDialog } from '@/components/AgentDialog';
import { Icon, cx } from '@/components/ui';

const EMPTY_STATUS: StatusSnapshot = {
  agentId: '',
  status: 'stopped',
  activity: null,
  pendingPermissions: [],
};

export default function Page() {
  const hub = useHub();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; agent: Agent | null }>({ open: false, agent: null });
  const [filter, setFilter] = useState<'all' | 'running'>('all');
  const [dark, setDark] = useState(false);

  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.theme = next ? 'dark' : 'light';
  };

  // Pick a sensible agent on first load, and never point at a deleted one.
  useEffect(() => {
    if (!hub.agents.length) {
      setActiveId(null);
      return;
    }
    if (!activeId || !hub.agents.some((a) => a.id === activeId)) {
      const first = hub.agents[0].id;
      setActiveId(first);
      hub.selectAgent(first);
    }
  }, [hub.agents, activeId, hub]);

  const select = (id: string) => {
    setActiveId(id);
    hub.selectAgent(id);
  };

  const agent = useMemo(() => hub.agents.find((a) => a.id === activeId) ?? null, [hub.agents, activeId]);
  const status = (activeId && hub.statuses[activeId]) || { ...EMPTY_STATUS, agentId: activeId ?? '' };
  const runningCount = Object.values(hub.statuses).filter((s) =>
    ['running', 'starting', 'waiting_for_permission'].includes(s.status),
  ).length;
  const alerts = Object.values(hub.statuses).filter((s) => s.status === 'waiting_for_permission').length;

  return (
    <main className="flex h-screen w-screen items-stretch p-3 sm:p-5">
      <div className="flex w-full overflow-hidden rounded-[26px] bg-[var(--shell)] shadow-[var(--shadow)]">
        {/* ---------------- icon rail ---------------- */}
        <nav className="flex w-[86px] shrink-0 flex-col items-center gap-2 bg-[var(--rail)] py-5">
          <div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-white/10 text-white">
            <Icon name="hub" className="h-5 w-5" />
          </div>

          <RailButton
            icon="chats"
            label="All agents"
            active={filter === 'all'}
            badge={Object.values(hub.unread).reduce((a, b) => a + b, 0)}
            onClick={() => setFilter('all')}
          />
          <RailButton
            icon="running"
            label="Running"
            active={filter === 'running'}
            badge={runningCount}
            badgeTone="ok"
            onClick={() => setFilter('running')}
          />
          <RailButton icon="shield" label="Permissions" badge={alerts} onClick={() => setFilter('all')} />

          <div className="mt-auto flex flex-col items-center gap-2">
            <RailButton icon={dark ? 'sun' : 'moon'} label="Theme" onClick={toggleTheme} />
            <RailButton icon="plus" label="New agent" onClick={() => setDialog({ open: true, agent: null })} />
            <div
              className={cx(
                'mt-2 h-2 w-2 rounded-full',
                hub.conn === 'open' ? 'bg-[var(--ok)]' : hub.conn === 'connecting' ? 'bg-[var(--busy)]' : 'bg-[var(--danger)]',
              )}
              title={`Hub ${hub.conn}`}
            />
          </div>
        </nav>

        {/* ---------------- agent list ---------------- */}
        <Sidebar
          agents={hub.agents}
          statuses={hub.statuses}
          events={hub.events}
          unread={hub.unread}
          activeId={activeId}
          onSelect={select}
          onCreate={() => setDialog({ open: true, agent: null })}
          filter={filter}
        />

        {/* ---------------- chat ---------------- */}
        {agent ? (
          <Chat
            key={agent.id}
            agent={agent}
            status={status}
            events={hub.events[agent.id] ?? []}
            streaming={hub.streaming[agent.id] ?? ''}
            onSend={(text) => hub.sendMessage(agent.id, text)}
            onPermission={(requestId, behavior) => hub.respondPermission(agent.id, requestId, behavior)}
            onStart={() => hub.start(agent.id)}
            onStop={() => hub.stop(agent.id)}
            onRestart={() => hub.restart(agent.id)}
            onInterrupt={() => hub.interrupt(agent.id)}
            onEdit={() => setDialog({ open: true, agent })}
            onClear={() => hub.clear(agent.id)}
          />
        ) : (
          <section className="grid flex-1 place-items-center bg-[var(--surface)] text-center">
            <div>
              <h2 className="text-xl font-bold">No agents yet</h2>
              <p className="mt-1 text-[13.5px] text-[var(--text-muted)]">
                Create one to start an independent Claude Code session.
              </p>
              <button
                type="button"
                onClick={() => setDialog({ open: true, agent: null })}
                className="mt-4 rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white"
              >
                New agent
              </button>
            </div>
          </section>
        )}
      </div>

      {dialog.open && (
        <AgentDialog
          agent={dialog.agent}
          onClose={() => setDialog({ open: false, agent: null })}
          onSaved={hub.refreshAgents}
          onDeleted={() => {
            setActiveId(null);
            hub.refreshAgents();
          }}
        />
      )}

      {hub.toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-[var(--danger)] px-4 py-2.5 text-sm font-medium text-white shadow-lg">
          {hub.toast}
        </div>
      )}
      {hub.conn === 'closed' && (
        <div className="fixed left-1/2 top-6 z-50 -translate-x-1/2 rounded-full bg-[var(--danger)] px-4 py-2 text-[13px] font-semibold text-white">
          Lost connection to the hub - retrying…
        </div>
      )}
    </main>
  );
}

function RailButton({
  icon,
  label,
  active,
  badge,
  badgeTone = 'alert',
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  badge?: number;
  badgeTone?: 'alert' | 'ok';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cx(
        'group relative grid h-[52px] w-[62px] place-items-center rounded-2xl transition',
        active ? 'bg-[var(--rail-active)] text-white' : 'text-[var(--rail-muted)] hover:bg-white/5 hover:text-white',
      )}
    >
      <Icon name={icon} className="h-[21px] w-[21px]" />
      <span className="mt-0.5 text-[9.5px] font-medium leading-none">{label.split(' ')[0]}</span>
      {!!badge && badge > 0 && (
        <span
          className="absolute right-2 top-1.5 grid h-[17px] min-w-[17px] place-items-center rounded-full px-1 text-[10px] font-bold text-white"
          style={{ background: badgeTone === 'ok' ? 'var(--ok)' : 'var(--alert)' }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
