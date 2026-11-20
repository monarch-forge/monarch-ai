/** Morning brief card (top of Home): the latest brief an automation saved with brief_save. */
import { useState } from 'preact/hooks';
import type { BriefItem, MorningBrief } from '@monarch/shared';
import { ChevronDown } from 'lucide-preact';
import { useResource } from '../../lib/store.ts';

const KEY = 'monarch.overview.brief';

function Section(props: { title: string; items: BriefItem[] }) {
  if (!props.items.length) return null;
  return (
    <div>
      <div class="text-[12px] text-fg-3 mb-1">{props.title}</div>
      <ul class="flex flex-col gap-1">
        {props.items.map((it, i) => (
          <li key={i} class="text-[13px] leading-snug">
            {it.href ? (
              <a href={it.href} class="text-fg hover:underline">
                {it.title}
              </a>
            ) : (
              <span class="text-fg">{it.title}</span>
            )}
            {it.detail && <span class="text-fg-3"> — {it.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BriefCard() {
  const res = useResource<MorningBrief | null>('/brief', ['automations']);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== '0';
    } catch {
      return true;
    }
  });
  const b = res.data;
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(KEY, open ? '0' : '1');
    } catch {
      /* ignore */
    }
  };
  if (!b) return null;
  const m = b.messages;
  const counts = [m.mail != null && `${m.mail} mail`, m.slack != null && `${m.slack} Slack`, m.whatsapp != null && `${m.whatsapp} WhatsApp`].filter(Boolean).join(' · ');
  return (
    <section class="bg-surface rounded-[var(--radius-card)] px-5 py-4" aria-label="Morning brief">
      <header class="flex items-center gap-2">
        <button type="button" class="flex items-center gap-1.5 text-[14px] font-semibold text-fg" onClick={toggle} aria-expanded={open}>
          Morning brief
          <ChevronDown size={14} strokeWidth={1.6} class={`text-fg-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        <span class="ml-auto text-[12px] text-fg-3">
          Generated {new Date(b.generatedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
        </span>
      </header>
      {open && (
        <div class="mt-3 grid gap-4 grid-cols-1 md:grid-cols-2">
          <Section title="Needs you" items={b.needsYou} />
          <Section title="Today" items={b.today} />
          <Section title={counts ? `Messages · ${counts}` : 'Messages'} items={m.top} />
          <Section title="Pull requests" items={b.prs} />
          <Section title="Money" items={b.money} />
        </div>
      )}
    </section>
  );
}
