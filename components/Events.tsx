'use client';

import { useState } from 'react';
import type { Agent, HubEvent } from '@/lib/types';
import { Avatar, Icon, cx, timeOf } from './ui';

const TOOL_ICON: Record<string, string> = {
  Bash: 'terminal',
  Read: 'file',
  Write: 'pencil',
  Edit: 'pencil',
  Glob: 'search',
  Grep: 'search',
  WebFetch: 'search',
  WebSearch: 'search',
  Plan: 'chats',
  Subagent: 'running',
};

/* --------------------------- chat bubbles ---------------------------- */

export function UserBubble({ event }: { event: HubEvent }) {
  return (
    <div className="rise flex justify-end gap-3">
      <div className="max-w-[min(640px,78%)]">
        <div className="rounded-[20px] rounded-br-[6px] bg-[var(--bubble-out)] px-4 py-2.5 text-[14.5px] leading-relaxed text-white shadow-[0_10px_24px_-14px_var(--accent)]">
          <p className="whitespace-pre-wrap break-words">{event.text}</p>
        </div>
        <div className="mt-1 pr-1 text-right text-[11px] text-[var(--text-soft)]">{timeOf(event.ts)}</div>
      </div>
    </div>
  );
}

export function AssistantBubble({
  agent,
  event,
  streamingText,
}: {
  agent: Agent;
  event?: HubEvent;
  streamingText?: string;
}) {
  const text = streamingText ?? event?.text ?? '';
  return (
    <div className="rise flex gap-3">
      <Avatar label={agent.name} accent={agent.accent} size={34} />
      <div className="max-w-[min(680px,80%)]">
        <div className="rounded-[20px] rounded-tl-[6px] bg-[var(--bubble-in)] px-4 py-2.5">
          <div className="mb-1 text-[12.5px] font-semibold text-[var(--accent-ink)]">{agent.name}</div>
          <div className={cx('whitespace-pre-wrap break-words text-[14.5px] leading-relaxed', streamingText && 'caret')}>
            {text}
          </div>
        </div>
        {event && <div className="mt-1 pl-1 text-[11px] text-[var(--text-soft)]">{timeOf(event.ts)}</div>}
      </div>
    </div>
  );
}

/* ----------------------------- tool card ----------------------------- */

export function ToolCard({ event, result }: { event: HubEvent; result?: HubEvent }) {
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICON[event.title ?? ''] ?? 'settings';
  const pending = !result;

  return (
    <div className="rise ml-[46px] max-w-[min(680px,80%)]">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition hover:bg-[var(--surface-2)]"
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent-ink)]">
            <Icon name={icon} className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">{event.title}</span>
            {event.detail && (
              <span className="block truncate font-mono text-[12px] text-[var(--text-muted)]">{event.detail}</span>
            )}
          </span>
          {pending ? (
            <span className="flex gap-0.5 pr-1">
              <Dot className="dot-1" />
              <Dot className="dot-2" />
              <Dot className="dot-3" />
            </span>
          ) : (
            <span
              className={cx(
                'shrink-0 rounded-lg px-2 py-1 text-[11.5px] font-semibold',
                result.isError
                  ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]'
                  : 'bg-[color-mix(in_srgb,var(--ok)_14%,transparent)] text-[var(--ok)]',
              )}
            >
              {result.isError ? '✕' : '✓'} {result.summary}
            </span>
          )}
          <Icon name="chevron" className={cx('h-4 w-4 shrink-0 text-[var(--text-soft)] transition', open && 'rotate-90')} />
        </button>

        {open && (
          <div className="border-t border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3">
            <Section title="Input">{event.input}</Section>
            {result?.text && <Section title={result.isError ? 'Error' : 'Output'}>{result.text}</Section>}
          </div>
        )}
      </div>
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={cx('h-1.5 w-1.5 rounded-full bg-[var(--text-soft)]', className)} />;
}

function Section({ title, children }: { title: string; children?: string }) {
  if (!children) return null;
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-soft)]">{title}</div>
      <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-3)] p-2.5 font-mono text-[12px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

/* -------------------------- permission card -------------------------- */

export function PermissionCard({
  event,
  onRespond,
}: {
  event: HubEvent;
  onRespond: (behavior: 'allow' | 'deny') => void;
}) {
  const pending = event.status === 'pending';
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div className="rise ml-[46px] max-w-[min(680px,80%)]">
      <div
        className={cx(
          'overflow-hidden rounded-2xl border-2 bg-[var(--surface)] transition',
          pending
            ? 'border-[var(--alert)] shadow-[0_14px_40px_-18px_var(--alert)]'
            : 'border-[var(--border)] opacity-80',
        )}
      >
        <div className="flex items-center gap-2.5 px-4 py-2.5" style={{ background: pending ? 'color-mix(in srgb, var(--alert) 10%, transparent)' : 'transparent' }}>
          <Icon name="shield" className={cx('h-4.5 w-4.5', pending ? 'text-[var(--alert)]' : 'text-[var(--text-soft)]')} />
          <span className={cx('text-[13px] font-bold', pending ? 'text-[var(--alert)]' : 'text-[var(--text-muted)]')}>
            {pending ? 'Permission requested' : `Permission ${event.status}`}
          </span>
          <span className="ml-auto text-[11px] text-[var(--text-soft)]">{timeOf(event.ts)}</span>
        </div>

        <div className="px-4 py-3">
          <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--text-soft)]">
            {event.displayName ?? event.toolName}
          </div>
          <pre className="scroll-thin max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[var(--surface-3)] p-3 font-mono text-[12.5px] leading-relaxed">
            {event.detail || event.toolName}
          </pre>

          <button
            type="button"
            onClick={() => setShowDetail((s) => !s)}
            className="mt-2 text-[11.5px] font-medium text-[var(--text-muted)] hover:text-[var(--accent-ink)]"
          >
            {showDetail ? 'Hide' : 'Show'} full request
          </button>
          {showDetail && (
            <pre className="scroll-thin mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[var(--surface-2)] p-3 font-mono text-[12px]">
              {event.input}
            </pre>
          )}

          {pending && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => onRespond('allow')}
                className="flex-1 rounded-xl bg-[var(--ok)] px-4 py-2.5 text-sm font-bold text-white transition hover:brightness-110"
              >
                Allow
              </button>
              <button
                type="button"
                onClick={() => onRespond('deny')}
                className="flex-1 rounded-xl bg-[var(--surface-3)] px-4 py-2.5 text-sm font-bold text-[var(--text-muted)] transition hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] hover:text-[var(--danger)]"
              >
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- system rows ---------------------------- */

export function SystemRow({ event }: { event: HubEvent }) {
  const danger = event.kind === 'error' || event.level === 'warn';
  return (
    <div className="rise flex justify-center">
      <div
        className={cx(
          'flex max-w-[80%] items-center gap-2 rounded-full px-3.5 py-1.5 text-[12px]',
          danger
            ? 'bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]'
            : 'bg-[var(--surface-2)] text-[var(--text-soft)]',
        )}
      >
        {danger && <Icon name="alert" className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate">{event.text}</span>
      </div>
    </div>
  );
}

export function ResultRow({ event }: { event: HubEvent }) {
  const bits = [
    event.durationMs ? `${(event.durationMs / 1000).toFixed(1)}s` : null,
    event.turns ? `${event.turns} turn${event.turns === 1 ? '' : 's'}` : null,
    event.costUsd ? `$${event.costUsd.toFixed(3)}` : null,
  ].filter(Boolean);
  return (
    <div className="flex justify-center py-1">
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-soft)]">
        <span className="h-px w-8 bg-[var(--border)]" />
        <span>{event.isError ? 'Turn failed' : 'Turn complete'}{bits.length ? ` · ${bits.join(' · ')}` : ''}</span>
        <span className="h-px w-8 bg-[var(--border)]" />
      </div>
    </div>
  );
}
