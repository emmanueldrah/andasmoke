import React from 'react';
import { CheckCircle2, Inbox, type LucideIcon } from 'lucide-react';

interface AdminPageHeaderProps {
  description: string;
  action?: React.ReactNode;
}

/**
 * The intro line of an admin screen.
 *
 * The sticky shell bar already names the section and the page, so repeating an
 * eyebrow and a heading here printed the same two lines twice on every screen.
 * What only a screen can say is what it does: the description and its actions.
 */
export function AdminPageHeader({ description, action }: AdminPageHeaderProps) {
  return (
    <header className="flex flex-col gap-4 border-b border-[var(--border-color)] pb-5 sm:flex-row sm:items-end sm:justify-between">
      <p className="max-w-2xl text-sm leading-6 text-[var(--text-muted)]">{description}</p>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  );
}

const metricAccents = {
  neutral: 'text-[var(--text-primary)]',
  green: 'text-[var(--jade)]',
  amber: 'text-[var(--highlight)]',
  red: 'text-[var(--danger)]',
  blue: 'text-[var(--violet)]',
  orange: 'text-[var(--accent)]',
  purple: 'text-[var(--violet)]',
} as const;

export function AdminMetricCard({
  label,
  value,
  detail,
  icon: Icon,
  accent = 'neutral',
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: LucideIcon;
  accent?: keyof typeof metricAccents;
}) {
  return (
    <article className="lux-card min-w-0 p-4 transition-shadow hover:shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--text-subtle)]">{label}</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
          <Icon className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
        </span>
      </div>
      <p className={`mt-3 truncate text-xl font-bold tabular-nums sm:text-2xl ${metricAccents[accent]}`} title={String(value)}>{value}</p>
      <p className="mt-1 truncate text-xs text-[var(--text-muted)]" title={detail}>{detail}</p>
    </article>
  );
}

export function AdminStatusBadge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }) {
  const styles = {
    neutral: 'bg-[color-mix(in_srgb,var(--text-subtle)_14%,transparent)] text-[var(--text-muted)]',
    success: 'bg-[var(--jade-soft)] text-[var(--jade)]',
    warning: 'bg-[color-mix(in_srgb,var(--highlight)_16%,transparent)] text-[var(--highlight)]',
    danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
    info: 'bg-[var(--violet-soft)] text-[var(--violet)]',
  };
  return <span className={`inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${styles[tone]}`}><span className="truncate">{label}</span></span>;
}

export function AdminEmptyState({ title, description, icon: Icon = Inbox, action }: { title: string; description: string; icon?: LucideIcon; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border-color)] bg-[color-mix(in_srgb,var(--bg-card)_60%,transparent)] px-6 py-12 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]"><Icon className="h-5 w-5" /></div>
      <h3 className="mt-4 text-sm font-bold text-[var(--text-primary)]">{title}</h3>
      <p className="mt-1 max-w-sm text-xs leading-5 text-[var(--text-muted)]">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function AdminSuccessMark({ label = 'All clear' }: { label?: string }) {
  return <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--jade)]"><CheckCircle2 className="h-4 w-4" />{label}</span>;
}

/**
 * Dense stat strip for POS screens. Unlike AdminMetricCard it takes a single
 * row instead of a full card, and each stat can double as a filter control so
 * the number and the action live in the same place.
 */
const stripTones = {
  neutral: 'text-[var(--text-primary)]',
  green: 'text-[var(--jade)]',
  amber: 'text-[var(--highlight)]',
  red: 'text-[var(--danger)]',
  accent: 'text-[var(--accent)]',
} as const;

export function AdminStatStrip({
  stats,
}: {
  stats: Array<{
    key: string;
    label: string;
    value: number | string;
    icon: LucideIcon;
    tone?: keyof typeof stripTones;
    active?: boolean;
    onClick?: () => void;
    title?: string;
  }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--border-color)] sm:grid-cols-3 lg:grid-cols-5">
      {stats.map(stat => {
        const Icon = stat.icon;
        const tone = stripTones[stat.tone || 'neutral'];
        const interactive = Boolean(stat.onClick);
        const Tag = interactive ? 'button' : 'div';
        return (
          <Tag
            key={stat.key}
            {...(interactive ? { type: 'button' as const, onClick: stat.onClick, title: stat.title } : {})}
            aria-pressed={interactive ? Boolean(stat.active) : undefined}
            className={`flex min-w-0 items-center gap-2.5 px-3.5 py-3 text-left transition ${
              stat.active
                ? 'bg-[var(--accent-soft)]'
                : interactive
                  ? 'bg-[var(--bg-card)] hover:bg-[var(--accent-soft)]'
                  : 'bg-[var(--bg-card)]'
            } ${interactive ? 'cursor-pointer' : ''}`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-soft)]">
              <Icon className={`h-3.5 w-3.5 ${tone}`} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--text-subtle)]">
                {stat.label}
              </span>
              <span className={`mt-0.5 block truncate text-lg font-extrabold leading-none tabular-nums ${tone}`}>
                {stat.value}
              </span>
            </span>
          </Tag>
        );
      })}
    </div>
  );
}
