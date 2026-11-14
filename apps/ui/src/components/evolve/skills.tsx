/** Evolve → Skills: learned procedures (markdown). List + viewer/editor. Route: #/evolve/skills/:id? ("new"). */
import { useMemo, useState } from 'preact/hooks';
import type { Skill, SkillSummary } from '@monarch/shared';
import { ArrowLeft, Eye, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { navigate, toast, useResource } from '../../lib/store.ts';
import { Btn, Panel, Tag } from '../ui.tsx';
import { Markdown } from '../chat/markdown.tsx';
import { useConfirm } from '../mail/kit.tsx';
import { CODE_AREA, EvoGate, EvoNote, OriginTag, ago, errMsg, stamp, tabIndentHandler } from './common.tsx';

export function SkillsTab(props: { id?: string }) {
  const list = useResource<SkillSummary[]>('/skills', ['skills']);
  const [q, setQ] = useState('');
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const all = list.data ?? [];
    return (t ? all.filter((s) => `${s.name} ${s.id} ${s.description}`.toLowerCase().includes(t)) : all).slice().sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  }, [list.data, q]);
  const selected = props.id;

  return (
    <div class="h-full min-h-0 grid gap-3 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)]">
      <Panel
        code="EVO.21"
        title="Skills"
        noPad
        bodyClass="flex flex-col"
        class={`min-h-0 ${selected ? 'hidden lg:flex' : ''}`}
        right={
          <>
            {list.data && <Tag tone="plain">{list.data.length}</Tag>}
            <Btn size="xs" variant="ghost" onClick={() => navigate('evolve/skills/new')} title="Write a new skill">
              <Plus size={12} /> New
            </Btn>
          </>
        }
      >
        {(list.data?.length ?? 0) > 5 && (
          <div class="px-3 py-2 border-b border-line">
            <label class="relative block">
              <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
              <input class="hud-input py-1.5! pl-7! text-[13px]!" placeholder="Filter skills…" aria-label="Filter skills" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </label>
          </div>
        )}
        <div class="flex-1 min-h-0 overflow-y-auto py-1">
          <EvoGate res={list} loadingLabel="Loading skills">
            {() =>
              items.length ? (
                <ul role="list">
                  {items.map((s) => (
                    <li key={s.id}>
                      <a href={`#/evolve/skills/${encodeURIComponent(s.id)}`} class="hud-row !items-start !py-2.5" data-active={s.id === selected ? 'true' : 'false'} aria-current={s.id === selected ? 'true' : undefined}>
                        <span class={`inline-block w-1.5 h-1.5 mt-1.5 shrink-0 ${s.origin === 'agent' ? 'bg-fg-2' : 'border border-fg-3'}`} title={s.origin} />
                        <span class="flex-1 min-w-0">
                          <span class="block text-[13px] text-fg truncate">{s.name}</span>
                          <span class="block text-[11.5px] text-fg-3 truncate mt-0.5">{s.description}</span>
                          <span class="flex items-center gap-3 mt-1.5 font-mono text-[10px] tracking-[0.08em] uppercase text-fg-3">
                            <span>{s.origin}</span>
                            <span>{s.uses} use{s.uses === 1 ? '' : 's'}</span>
                            <span class="ml-auto normal-case">{ago(s.updatedAt)}</span>
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : q ? (
                <EvoNote label="No match" />
              ) : (
                <EvoNote
                  icon
                  label="No skills yet"
                  sub="Skills are procedures Monarch learned — how you like things done. It writes them as it goes; you can add your own."
                  action={
                    <Btn size="xs" onClick={() => navigate('evolve/skills/new')}>
                      <Plus size={11} /> New skill
                    </Btn>
                  }
                />
              )
            }
          </EvoGate>
        </div>
      </Panel>

      <div class={`min-h-0 ${selected ? 'flex' : 'hidden lg:flex'} flex-col`}>
        {selected === 'new' ? (
          <SkillEditorPanel key="new" />
        ) : selected ? (
          <SkillDetail key={selected} id={selected} />
        ) : (
          <Panel code="EVO.22" title="Skill" class="flex-1">
            <EvoNote label="Select a skill" sub="Read or refine the procedure. Monarch sees the name and description of every skill and reads the body on demand." />
          </Panel>
        )}
      </div>
    </div>
  );
}

function SkillDetail(props: { id: string }) {
  const res = useResource<Skill>(`/skills/${encodeURIComponent(props.id)}`, ['skills']);
  const [editing, setEditing] = useState(false);
  const [confirmEl, confirm] = useConfirm();
  const [busy, setBusy] = useState(false);
  const s = res.data;

  const remove = async () => {
    if (!s) return;
    if (!(await confirm({ title: `Delete skill "${s.name}"?`, body: 'The skill file is removed and Monarch stops seeing it. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    setBusy(true);
    try {
      await api.del(`/skills/${encodeURIComponent(s.id)}`);
      toast('Skill deleted', 'success');
      navigate('evolve/skills');
    } catch (e) {
      toast(`Delete failed: ${errMsg(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (s && editing) return <SkillEditorPanel skill={s} onDone={() => (setEditing(false), void res.reload())} />;

  return (
    <Panel
      code="EVO.22"
      title={s?.name ?? props.id}
      class="flex-1"
      noPad
      bodyClass="flex flex-col"
      right={
        s && (
          <>
            <OriginTag origin={s.origin} />
            <Tag tone="plain">{s.uses} uses</Tag>
          </>
        )
      }
    >
      <EvoGate res={res} loadingLabel="Loading skill">
        {(s) => (
          <>
            <div class="px-4 py-3 border-b border-line flex items-start gap-3 flex-wrap">
              <button class="lg:hidden text-fg-3 hover:text-fg mt-0.5" onClick={() => navigate('evolve/skills')} aria-label="Back to skills">
                <ArrowLeft size={14} />
              </button>
              <div class="flex-1 min-w-[200px]">
                <div class="font-mono text-[12px] text-fg-2">{s.id}.md</div>
                <p class="text-[13px] text-fg-2 mt-1 leading-relaxed">{s.description}</p>
                <div class="font-mono text-[10px] text-fg-3 mt-1">updated {stamp(s.updatedAt)}</div>
              </div>
              <div class="flex gap-1.5">
                <Btn size="xs" onClick={() => setEditing(true)}>
                  <Pencil size={11} /> Edit
                </Btn>
                <Btn size="xs" variant="ghost" class="hover:text-red!" onClick={() => void remove()} loading={busy} aria-label="Delete skill" title="Delete skill">
                  {!busy && <Trash2 size={11} />}
                </Btn>
              </div>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              <div class="max-w-[78ch]">{s.body.trim() ? <Markdown text={s.body} /> : <EvoNote label="Empty skill" />}</div>
            </div>
            {confirmEl}
          </>
        )}
      </EvoGate>
    </Panel>
  );
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function SkillEditorPanel(props: { skill?: Skill; onDone?: () => void }) {
  const isNew = !props.skill;
  const [name, setName] = useState(props.skill?.name ?? '');
  const [id, setId] = useState(props.skill?.id ?? '');
  const [idTouched, setIdTouched] = useState(false);
  const [description, setDescription] = useState(props.skill?.description ?? '');
  const [body, setBody] = useState(props.skill?.body ?? '## When to use\n\n\n## Steps\n\n1. \n');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const effId = isNew && !idTouched ? slug(name) : id;
  const valid = ID_RE.test(effId) && name.trim() && description.trim();

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await api.put(`/skills/${encodeURIComponent(effId)}`, { name: name.trim(), description: description.trim(), body });
      toast('Skill saved', 'success');
      if (isNew) navigate(`evolve/skills/${encodeURIComponent(effId)}`);
      else props.onDone?.();
    } catch (e) {
      toast(`Save failed: ${errMsg(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => (isNew ? navigate('evolve/skills') : props.onDone?.());

  return (
    <Panel
      code="EVO.23"
      title={isNew ? 'New skill' : `Edit · ${props.skill!.name}`}
      class="flex-1"
      noPad
      bodyClass="flex flex-col"
      right={
        <Btn size="xs" variant="ghost" onClick={() => setPreview(!preview)} aria-pressed={preview}>
          {preview ? <Pencil size={11} /> : <Eye size={11} />} {preview ? 'Write' : 'Preview'}
        </Btn>
      }
    >
      <div class="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div class="flex flex-col gap-1.5">
            <label class="hud-label text-[10px]" for="skill-name">
              Name
            </label>
            <input id="skill-name" class="hud-input py-1.5! text-[13px]!" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Weekly report" />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="hud-label text-[10px]" for="skill-id">
              File id {!ID_RE.test(effId) && effId && <span class="text-red normal-case tracking-normal">kebab-case only</span>}
            </label>
            <input
              id="skill-id"
              class="hud-input py-1.5! text-[13px]! font-mono disabled:opacity-60"
              value={effId}
              disabled={!isNew}
              onInput={(e) => {
                setIdTouched(true);
                setId((e.target as HTMLInputElement).value);
              }}
              placeholder="weekly-report"
              spellcheck={false}
            />
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="hud-label text-[10px]" for="skill-desc">
            Description <span class="text-fg-3 normal-case tracking-normal">— shown to Monarch in every prompt; say when to use it</span>
          </label>
          <input id="skill-desc" class="hud-input py-1.5! text-[13px]!" value={description} onInput={(e) => setDescription((e.target as HTMLInputElement).value)} placeholder="Use when the user asks for the Friday status report" />
        </div>
        <div class="flex flex-col gap-1.5 flex-1 min-h-[300px]">
          <label class="hud-label text-[10px]" for="skill-body">
            Body · markdown
          </label>
          {preview ? (
            <div class="border border-line bg-[#121213] p-4 flex-1 overflow-y-auto">{body.trim() ? <Markdown text={body} /> : <EvoNote label="Nothing to preview" />}</div>
          ) : (
            <textarea
              id="skill-body"
              class={`${CODE_AREA} flex-1 min-h-[300px] font-mono`}
              spellcheck
              value={body}
              onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault();
                  void save();
                } else tabIndentHandler(e, setBody);
              }}
            />
          )}
        </div>
      </div>
      <div class="flex items-center gap-2 px-4 py-2.5 border-t border-line">
        <span class="font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 flex-1">{isNew ? 'saved as skills/' + (effId || '…') + '.md' : 'Ctrl+S saves'}</span>
        <Btn size="sm" variant="ghost" onClick={cancel}>
          <X size={11} /> Cancel
        </Btn>
        <Btn size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!valid}>
          {!saving && <Save size={11} />} Save
        </Btn>
      </div>
    </Panel>
  );
}
