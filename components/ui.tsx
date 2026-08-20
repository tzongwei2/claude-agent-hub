'use client';

import type { ReactNode } from 'react';
import type { AgentStatus } from '@/lib/types';
import { STATUS_META } from '@/lib/types';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------- icons -------------------------------- */

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function Icon({ name, className = 'w-5 h-5' }: { name: string; className?: string }) {
  const paths: Record<string, ReactNode> = {
    hub: <path d="M4 7h16M4 12h10M4 17h7" {...S} />,
    chats: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.3A8 8 0 1 1 21 12Z" {...S} />,
    running: <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" {...S} />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" {...S} />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14a1.7 1.7 0 0 0-1.6-1H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.7 8a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-1.6V2a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 16 3.6a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H22a1.7 1.7 0 0 0-1.6 1Z" {...S} />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" {...S} />
        <path d="m20 20-3.5-3.5" {...S} />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" {...S} />,
    send: <path d="M4.5 12 20 4l-4 16-4.5-6.5L4.5 12Z" {...S} />,
    chevron: <path d="m9 6 6 6-6 6" {...S} />,
    play: <path d="M7 4.5v15l13-7.5-13-7.5Z" {...S} />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2.5" {...S} />,
    refresh: <path d="M20 11a8 8 0 1 0-2.3 6M20 5v6h-6" {...S} />,
    trash: <path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13" {...S} />,
    pencil: <path d="M4 20h4L20 8l-4-4L4 16v4Z" {...S} />,
    shield: <path d="M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6l-7-3Z" {...S} />,
    sun: (
      <>
        <circle cx="12" cy="12" r="4" {...S} />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" {...S} />
      </>
    ),
    moon: <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" {...S} />,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" {...S} />,
    terminal: <path d="M5 5h14v14H5zM8.5 9.5l2.5 2.5-2.5 2.5M13 15h3" {...S} />,
    file: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" {...S} />,
    check: <path d="m5 13 4 4L19 7" {...S} />,
    x: <path d="M6 6l12 12M18 6 6 18" {...S} />,
    alert: <path d="M12 8v5m0 3h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" {...S} />,
    dots: (
      <>
        <circle cx="12" cy="5" r="1.4" fill="currentColor" />
        <circle cx="12" cy="12" r="1.4" fill="currentColor" />
        <circle cx="12" cy="19" r="1.4" fill="currentColor" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      {paths[name] ?? null}
    </svg>
  );
}

/* ------------------------------ avatar -------------------------------- */

const ACCENTS: Record<string, string> = {
  violet: 'linear-gradient(145deg,#7c5cfc,#5b3fd6)',
  amber: 'linear-gradient(145deg,#f7a44b,#e2761b)',
  emerald: 'linear-gradient(145deg,#3fca8b,#1f9c66)',
  rose: 'linear-gradient(145deg,#fb7185,#d63f5d)',
  sky: 'linear-gradient(145deg,#54b6f7,#2b7fd4)',
  slate: 'linear-gradient(145deg,#8b8a99,#5c5b68)',
};

export const ACCENT_KEYS = Object.keys(ACCENTS);

export function Avatar({
  label,
  accent = 'violet',
  size = 44,
  status,
}: {
  label: string;
  accent?: string;
  size?: number;
  status?: AgentStatus;
}) {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="grid h-full w-full place-items-center rounded-[35%] font-semibold text-white"
        style={{ background: ACCENTS[accent] ?? ACCENTS.violet, fontSize: size * 0.36 }}
      >
        {initials || '?'}
      </div>
      {status && (
        <span
          className={cx(
            'absolute -bottom-0.5 -right-0.5 rounded-full border-[2.5px]',
            status === 'waiting_for_permission' && 'pulse-ring',
          )}
          style={{
            width: size * 0.3,
            height: size * 0.3,
            background: STATUS_META[status].color,
            borderColor: 'var(--surface)',
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ controls ------------------------------ */

export function IconButton({
  icon,
  onClick,
  title,
  tone = 'ghost',
  className,
}: {
  icon: string;
  onClick?: () => void;
  title?: string;
  tone?: 'ghost' | 'accent' | 'danger';
  className?: string;
}) {
  const tones = {
    ghost: 'text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]',
    accent: 'text-white bg-[var(--accent)] hover:brightness-110',
    danger: 'text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]',
  };
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx('grid h-9 w-9 place-items-center rounded-xl transition', tones[tone], className)}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  type = 'button',
  className,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'soft';
  type?: 'button' | 'submit';
  className?: string;
  disabled?: boolean;
}) {
  const variants = {
    primary: 'bg-[var(--accent)] text-white hover:brightness-110 shadow-[0_8px_20px_-8px_var(--accent)]',
    soft: 'bg-[var(--surface-3)] text-[var(--accent-ink)] hover:brightness-97',
    ghost: 'text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]',
    danger: 'bg-[var(--danger)] text-white hover:brightness-110',
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[var(--text-soft)]">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none transition placeholder:text-[var(--text-soft)] focus:border-[var(--accent)] focus:bg-[var(--surface)]';

export function timeOf(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function agoOf(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
