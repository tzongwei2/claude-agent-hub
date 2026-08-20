'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, HubEvent, StatusSnapshot } from '@/lib/types';
import { STATUS_META } from '@/lib/types';
import { Avatar, Icon, IconButton, cx } from './ui';
import { AssistantBubble, PermissionCard, ResultRow, SystemRow, ToolCard, UserBubble } from './Events';

interface Props {
  agent: Agent;
  status: StatusSnapshot;
  events: HubEvent[];
  streaming: string;
  onSend: (text: string) => void;
  onPermission: (requestId: string, behavior: 'allow' | 'deny') => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onInterrupt: () => void;
  onEdit: () => void;
  onClear: () => void;
}

export function Chat(props: Props) {
  const { agent, status, events, streaming } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(false);

  // Pair tool_use with its tool_result so the chat shows one card, not two.
  const rows = useMemo(() => buildRows(events), [events]);
  const pendingPermission = events.some((e) => e.kind === 'permission' && e.status === 'pending');
  const live = ['running', 'starting'].includes(status.status);

  useEffect(() => {
    if (pinned) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [rows.length, streaming, pinned]);

  useEffect(() => setDraft(''), [agent.id]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    props.onSend(text);
    setDraft('');
    setPinned(true);
  };

  const meta = STATUS_META[status.status];

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-[var(--surface)]">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-6 py-4">
        <Avatar label={agent.name} accent={agent.accent} size={40} status={status.status} />
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-bold leading-tight tracking-[-0.01em]">{agent.name}</h1>
          <p className="flex items-center gap-1.5 truncate text-[12.5px] text-[var(--text-muted)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
            {status.activity ?? meta.label}
            <span className="text-[var(--text-soft)]">·</span>
            <span className="truncate font-mono text-[11.5px] text-[var(--text-soft)]">{agent.workingDirectory}</span>
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {live && <IconButton icon="stop" title="Interrupt this turn" onClick={props.onInterrupt} />}
          {status.status === 'stopped' || status.status === 'error' ? (
            <IconButton icon="play" title="Start session" onClick={props.onStart} />
          ) : (
            <IconButton icon="stop" title="Stop session" onClick={props.onStop} />
          )}
          <IconButton icon="refresh" title="Restart session" onClick={props.onRestart} />
          <IconButton icon="pencil" title="Edit agent" onClick={props.onEdit} />
          <div className="relative">
            <IconButton icon="dots" title="More" onClick={() => setMenu((m) => !m)} />
            {menu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <div className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow)]">
                  <MenuItem
                    label="Clear chat history"
                    onClick={() => {
                      props.onClear();
                      setMenu(false);
                    }}
                  />
                  <div className="px-3 py-2 text-[11px] leading-relaxed text-[var(--text-soft)]">
                    Session
                    <div className="font-mono text-[10.5px]">{status.claudeSessionId?.slice(0, 18) ?? 'none'}</div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* messages */}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="scroll-thin flex-1 space-y-3 overflow-y-auto px-6 py-6"
        style={{ background: 'var(--surface)' }}
      >
        {rows.length === 0 && !streaming && <EmptyState agent={agent} />}

        {rows.map((row) => {
          switch (row.kind) {
            case 'user':
              return <UserBubble key={row.id} event={row} />;
            case 'assistant':
              return <AssistantBubble key={row.id} agent={agent} event={row} />;
            case 'tool_use':
              return <ToolCard key={row.id} event={row} result={row.result} />;
            case 'permission':
              return (
                <PermissionCard
                  key={row.id}
                  event={row}
                  onRespond={(behavior) => props.onPermission(row.requestId!, behavior)}
                />
              );
            case 'result':
              return <ResultRow key={row.id} event={row} />;
            default:
              return <SystemRow key={row.id} event={row} />;
          }
        })}

        {streaming && <AssistantBubble agent={agent} streamingText={streaming} />}
        {live && !streaming && <Typing agent={agent} label={status.activity ?? 'Thinking…'} />}
      </div>

      {/* permission banner */}
      {pendingPermission && (
        <div className="flex items-center gap-2 border-t border-[var(--alert)] bg-[color-mix(in_srgb,var(--alert)_12%,transparent)] px-6 py-2.5 text-[13px] font-semibold text-[var(--alert)]">
          <Icon name="shield" className="h-4 w-4" />
          This agent is paused, waiting for your decision above.
        </div>
      )}

      {/* composer */}
      <footer className="border-t border-[var(--border)] px-6 py-4">
        <div className="flex items-end gap-2 rounded-2xl bg-[var(--surface-2)] px-3 py-2 focus-within:ring-2 focus-within:ring-[var(--accent)]/25">
          <textarea
            rows={1}
            value={draft}
            placeholder={`Message ${agent.name}…`}
            onChange={(e) => {
              setDraft(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="scroll-thin max-h-44 flex-1 resize-none bg-transparent px-1.5 py-2 text-[14.5px] leading-relaxed outline-none placeholder:text-[var(--text-soft)]"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="mb-0.5 grid h-9 w-9 place-items-center rounded-xl bg-[var(--accent)] text-white transition hover:brightness-110 disabled:opacity-35"
          >
            <Icon name="send" className="h-4.5 w-4.5" />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-3 px-1 text-[11px] text-[var(--text-soft)]">
          <span>Enter to send · Shift+Enter for a new line</span>
          {status.status === 'stopped' && <span>· sending will start the session automatically</span>}
        </div>
      </footer>
    </section>
  );
}


function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full px-3 py-2 text-left text-[13px] hover:bg-[var(--surface-2)]"
    >
      {label}
    </button>
  );
}

function Typing({ agent, label }: { agent: Agent; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <Avatar label={agent.name} accent={agent.accent} size={34} />
      <div className="flex items-center gap-2 rounded-[20px] rounded-tl-[6px] bg-[var(--bubble-in)] px-4 py-3">
        <span className="flex gap-1">
          <i className="dot-1 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
          <i className="dot-2 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
          <i className="dot-3 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
        </span>
        <span className="text-[12.5px] text-[var(--text-muted)]">{label}</span>
      </div>
    </div>
  );
}

function EmptyState({ agent }: { agent: Agent }) {
  return (
    <div className="grid h-full place-items-center py-16 text-center">
      <div>
        <Avatar label={agent.name} accent={agent.accent} size={72} />
        <h2 className="mt-4 text-lg font-bold">{agent.name}</h2>
        <p className="mx-auto mt-1 max-w-sm text-[13.5px] text-[var(--text-muted)]">
          {agent.description || 'An independent Claude Code session.'}
        </p>
        <p className="mt-3 font-mono text-[11.5px] text-[var(--text-soft)]">{agent.workingDirectory}</p>
      </div>
    </div>
  );
}

type Row = HubEvent & { result?: HubEvent };

function buildRows(events: HubEvent[]): Row[] {
  const rows: Row[] = [];
  const toolIndex = new Map<string, number>();

  for (const e of events) {
    if (e.kind === 'tool_result') {
      const at = e.toolUseId ? toolIndex.get(e.toolUseId) : undefined;
      if (at !== undefined) rows[at] = { ...rows[at], result: e };
      continue;
    }
    if (e.kind === 'tool_use' && e.toolUseId) toolIndex.set(e.toolUseId, rows.length);
    rows.push(e);
  }
  return rows;
}
