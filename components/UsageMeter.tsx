'use client';

import { useEffect, useState } from 'react';
import type { UsageWindow } from '@/lib/types';
import { Icon, cx } from './ui';

/**
 * The trip meter.
 *
 * Every number here is computed locally from data Claude Code already reports
 * on each turn - displaying it costs nothing. There is deliberately no
 * percentage: the limit's denominator is not published anywhere in the stream,
 * so a progress bar would be invented. Until a real ceiling is known, this
 * shows consumption and trend instead of a fake fraction.
 */
export function UsageMeter({ usage, budget }: { usage: UsageWindow | null; budget: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  // Tick once a minute so the countdown stays honest without churning.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  if (!usage) return null;

  const status = usage.rateLimit?.status ?? 'unknown';
  const healthy = status === 'allowed' || status === 'unknown';
  const pct = budget ? Math.min(100, (usage.tokens / budget) * 100) : null;

  return (
    <div className="border-t border-[var(--border)] px-3 py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition hover:bg-[var(--surface-2)]"
      >
        <span
          className={cx('h-2 w-2 shrink-0 rounded-full', !healthy && 'pulse-ring')}
          style={{ background: healthy ? 'var(--ok)' : 'var(--alert)' }}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold">{fmt(usage.tokens)} tokens</span>
          <span className="block truncate text-[11px] text-[var(--text-soft)]">
            {windowLabel(usage.windowType)} · {resetLabel(usage.resetsAt, now)}
          </span>
        </span>
        <Icon
          name="chevron"
          className={cx('h-3.5 w-3.5 shrink-0 text-[var(--text-soft)] transition', open && '-rotate-90')}
        />
      </button>

      {/* Only a real, user-supplied ceiling produces a bar. */}
      {pct !== null && (
        <div className="mt-2 px-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-3)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${pct}%`,
                background: pct > 85 ? 'var(--danger)' : pct > 60 ? 'var(--busy)' : 'var(--accent)',
              }}
            />
          </div>
          <div className="mt-1 text-[10.5px] text-[var(--text-soft)]">
            {Math.round(pct)}% of your {fmt(budget!)} budget
          </div>
        </div>
      )}

      {open && (
        <div className="mt-2 space-y-1.5 px-2">
          {usage.byAgent.length === 0 && (
            <p className="text-[11px] text-[var(--text-soft)]">No turns in this window yet.</p>
          )}
          {usage.byAgent.map((a) => (
            <div key={a.agentId} className="flex items-baseline gap-2 text-[11.5px]">
              <span className="truncate text-[var(--text-muted)]">{a.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px]">{fmt(a.tokens)}</span>
            </div>
          ))}
          <div className="mt-1 border-t border-[var(--border)] pt-1.5 text-[10.5px] leading-relaxed text-[var(--text-soft)]">
            {usage.turns} turn{usage.turns === 1 ? '' : 's'} · cache reads {fmt(usage.cacheRead)} (not counted)
            <br />
            No percentage is shown because the limit is not published. Run{' '}
            <span className="font-mono">/usage</span> in a terminal for the real figure.
          </div>
        </div>
      )}
    </div>
  );
}

/** The warning light - hidden entirely while everything is healthy. */
export function RateLimitBanner({ usage }: { usage: UsageWindow | null }) {
  const status = usage?.rateLimit?.status;
  if (!status || status === 'allowed') return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-[var(--alert)] px-4 py-2 text-[13px] font-semibold text-white">
      <Icon name="alert" className="h-4 w-4" />
      Rate limit status: {status}
      {usage?.resetsAt && ` · resets ${resetLabel(usage.resetsAt, Date.now())}`}
    </div>
  );
}

/* ------------------------------ helpers ------------------------------- */

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function windowLabel(type: string) {
  if (type === 'five_hour') return '5-hour window';
  if (type === 'seven_day' || type === 'weekly') return 'weekly window';
  return type.replace(/_/g, ' ');
}

function resetLabel(resetsAt: number | null, now: number) {
  if (!resetsAt) return 'reset time unknown';
  const ms = resetsAt - now;
  if (ms <= 0) return 'resetting now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `resets in ${h}h${m ? ` ${m}m` : ''}`;
}
