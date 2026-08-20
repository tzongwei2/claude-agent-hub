'use client';

import { useEffect, useState } from 'react';
import type { Agent } from '@/lib/types';
import { ACCENT_KEYS, Button, Field, Icon, cx, inputClass } from './ui';

interface Props {
  agent: Agent | null; // null => create
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

const MODELS = [
  { value: '', label: 'Default (Claude Code setting)' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

const MODES = [
  { value: 'manual', label: 'Ask me every time (recommended)' },
  { value: 'acceptEdits', label: 'Auto-accept file edits' },
  { value: 'plan', label: 'Plan mode (read-only)' },
];

export function AgentDialog({ agent, onClose, onSaved, onDeleted }: Props) {
  const [form, setForm] = useState({
    name: agent?.name ?? '',
    description: agent?.description ?? '',
    accent: agent?.accent ?? 'violet',
    workingDirectory: agent?.workingDirectory ?? '',
    systemPrompt: agent?.systemPrompt ?? '',
    agentKey: agent?.agentKey ?? '',
    model: agent?.model ?? '',
    permissionMode: agent?.permissionMode ?? 'manual',
  });
  const [error, setError] = useState<string | null>(null);
  const [pathState, setPathState] = useState<'unknown' | 'ok' | 'bad'>('unknown');
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    const dir = form.workingDirectory.trim();
    if (!dir) return setPathState('unknown');
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/validate-path', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        const data = await res.json();
        setPathState(data.exists ? 'ok' : 'bad');
      } catch {
        setPathState('unknown');
      }
    }, 350);
    return () => clearTimeout(t);
  }, [form.workingDirectory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(agent ? `/api/agents/${agent.id}` : '/api/agents', {
        method: agent ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not save the agent');
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
    onDeleted();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="scroll-thin max-h-[88vh] w-full max-w-xl overflow-y-auto rounded-3xl bg-[var(--surface)] p-6 shadow-[var(--shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-bold">{agent ? 'Edit agent' : 'New agent'}</h2>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-[var(--surface-2)]">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="AWS Engineer" />
            </Field>
            <Field label="Accent">
              <div className="flex gap-2 pt-1">
                {ACCENT_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => set('accent', key)}
                    className={cx(
                      'h-8 w-8 rounded-full ring-offset-2 ring-offset-[var(--surface)] transition',
                      form.accent === key && 'ring-2 ring-[var(--accent)]',
                    )}
                    style={{ background: `var(--accent-${key})` }}
                  >
                    <span
                      className="block h-full w-full rounded-full"
                      style={{
                        background: {
                          violet: 'linear-gradient(145deg,#7c5cfc,#5b3fd6)',
                          amber: 'linear-gradient(145deg,#f7a44b,#e2761b)',
                          emerald: 'linear-gradient(145deg,#3fca8b,#1f9c66)',
                          rose: 'linear-gradient(145deg,#fb7185,#d63f5d)',
                          sky: 'linear-gradient(145deg,#54b6f7,#2b7fd4)',
                          slate: 'linear-gradient(145deg,#8b8a99,#5c5b68)',
                        }[key],
                      }}
                    />
                  </button>
                ))}
              </div>
            </Field>
          </div>

          <Field label="Description">
            <input
              className={inputClass}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Owns the infrastructure repo"
            />
          </Field>

          <Field label="Working directory" hint="Claude Code launches with this as its cwd. Must already exist.">
            <div className="relative">
              <input
                className={cx(inputClass, 'pr-24 font-mono text-[13px]')}
                value={form.workingDirectory}
                onChange={(e) => set('workingDirectory', e.target.value)}
                placeholder="/home/you/projects/infra"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold">
                {pathState === 'ok' && <span className="text-[var(--ok)]">✓ exists</span>}
                {pathState === 'bad' && <span className="text-[var(--danger)]">not found</span>}
              </span>
            </div>
          </Field>

          <Field
            label="Role / system prompt"
            hint="Appended to Claude Code's own system prompt (--append-system-prompt)."
          >
            <textarea
              className={cx(inputClass, 'min-h-[90px] resize-y')}
              value={form.systemPrompt}
              onChange={(e) => set('systemPrompt', e.target.value)}
              placeholder="You are an AWS infrastructure specialist. Prefer SAM templates…"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Model">
              <select className={inputClass} value={form.model} onChange={(e) => set('model', e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Native agent" hint="Uses Claude Code's own --agent definition.">
              <input
                className={inputClass}
                value={form.agentKey}
                onChange={(e) => set('agentKey', e.target.value)}
                placeholder="e.g. reviewer"
              />
            </Field>
          </div>

          <Field label="Permissions">
            <select
              className={inputClass}
              value={form.permissionMode}
              onChange={(e) => set('permissionMode', e.target.value)}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>

          {error && (
            <p className="rounded-xl bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-3 py-2 text-[13px] text-[var(--danger)]">
              {error}
            </p>
          )}
        </div>

        <div className="mt-6 flex items-center gap-2">
          {agent && (
            <Button variant="ghost" onClick={remove} className="!text-[var(--danger)]">
              Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !form.name.trim() || pathState === 'bad'}>
              {saving ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
