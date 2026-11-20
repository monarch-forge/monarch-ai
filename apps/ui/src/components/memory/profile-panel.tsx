/** "What Monarch knows": the auto-learned Monarch/Profile.md as editable lines per section. */
import { useState } from 'preact/hooks';
import type { MemoryNote } from '@monarch/shared';
import { ArrowLeft, Pencil, Plus, Trash } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { navigate, toast, useResource } from '../../lib/store.ts';
import { Btn } from '../ui.tsx';
import { LoadError, Loading } from '../mail/kit.tsx';

const NOTE = 'Monarch/Profile';
const SECTIONS = ['Preferences', 'People', 'Work', 'Personal'];
type Profile = [string, string[]][];

// same format as apps/core/src/agent/profile-learn.ts
function parse(body: string): Profile {
  const p = new Map<string, string[]>(SECTIONS.map((s) => [s, []]));
  let cur = 'Preferences';
  for (const line of body.split('\n')) {
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) {
      cur = h[1];
      if (!p.has(cur)) p.set(cur, []);
    } else if (/^\s*[-*]\s+\S/.test(line)) p.get(cur)!.push(line.replace(/^\s*[-*]\s+/, '').trim());
  }
  return [...p];
}
const render = (p: Profile) => p.map(([s, l]) => `## ${s}\n${l.map((x) => `- ${x}`).join('\n')}`).join('\n\n') + '\n';

export function ProfilePanel() {
  const res = useResource<MemoryNote>(`/memory/notes/${encodeURIComponent(NOTE)}`, ['memory']);
  const missing = /not found|404/i.test(res.error ?? ''); // no profile learned yet
  const [edit, setEdit] = useState<{ s: number; i: number; text: string } | null>(null);
  if (res.data === undefined && !missing) return res.error ? <LoadError error={res.error} onRetry={res.reload} /> : <Loading label="Loading profile" />;
  const profile = parse(res.data?.body ?? '');

  const save = async (next: Profile) => {
    try {
      await api.put(`/memory/notes/${encodeURIComponent(NOTE)}`, { title: 'Profile', body: render(next) });
      setEdit(null);
      res.reload();
    } catch (e) {
      toast(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };
  const change = (s: number, i: number, text: string | null) =>
    save(profile.map(([name, lines], k) => {
      if (k !== s) return [name, lines];
      const l = [...lines];
      if (text === null) l.splice(i, 1);
      else l[i] = text;
      return [name, l.filter((x) => x.trim())];
    }));

  return (
    <div class="flex flex-col min-h-0 h-full">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <Btn variant="ghost" size="xs" onClick={() => navigate('#/memory')} aria-label="Back">
          <ArrowLeft size={14} />
        </Btn>
        <h2 class="text-[14px] font-medium">What Monarch knows</h2>
      </div>
      <div class="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        <p class="text-[12px] text-fg-3">Learned from your chats. Edit or remove anything that is wrong.</p>
        {profile.map(([name, lines], s) => (
          <section key={name}>
            <div class="flex items-center justify-between mb-1">
              <h3 class="text-[12px] uppercase tracking-wide text-fg-3">{name}</h3>
              <Btn variant="ghost" size="xs" aria-label={`Add to ${name}`} onClick={() => setEdit({ s, i: lines.length, text: '' })}>
                <Plus size={13} />
              </Btn>
            </div>
            <ul class="space-y-1">
              {[...lines, ...(edit?.s === s && edit.i === lines.length ? [''] : [])].map((line, i) =>
                edit?.s === s && edit.i === i ? (
                  <li key={i}>
                    <input
                      class="w-full bg-[#121213] rounded-[var(--radius-control)] px-2 py-1 text-[13px] outline-none"
                      value={edit.text}
                      autoFocus
                      aria-label="Fact"
                      onInput={(e) => setEdit({ ...edit, text: (e.target as HTMLInputElement).value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') change(s, i, edit.text);
                        else if (e.key === 'Escape') setEdit(null);
                      }}
                      onBlur={() => setEdit(null)}
                    />
                  </li>
                ) : (
                  <li key={i} class="group flex items-start gap-2 text-[13px]">
                    <span class="flex-1">{line}</span>
                    <button class="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-3" aria-label="Edit" onClick={() => setEdit({ s, i, text: line })}>
                      <Pencil size={12} />
                    </button>
                    <button class="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-3" aria-label="Delete" onClick={() => change(s, i, null)}>
                      <Trash size={12} />
                    </button>
                  </li>
                ),
              )}
              {!lines.length && !(edit?.s === s) && <li class="text-[12px] text-fg-3">Nothing yet</li>}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
