/** Config → Projects: folders of git repos; Monarch detects each repo's stack, commands and check command. */
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { ProjectView, RepoProfile } from '@monarch/shared';
import { FolderGit2, FolderOpen, RefreshCw, Trash2, ChevronRight } from 'lucide-preact';
import { api } from '../../lib/api.ts';
import { toast, useResource } from '../../lib/store.ts';
import { Btn, EmptyState, Panel, Skeleton, Spinner, Tag } from '../ui.tsx';
import { useConfirm } from '../mail/kit.tsx';
import { INPUT } from './fields.tsx';
import { DirBrowser } from './dir-browser.tsx';

const enc = encodeURIComponent;

export function ProjectsSection() {
  const list = useResource<ProjectView[]>('/projects', ['projects']);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, confirm] = useConfirm();

  const add = async (root: string) => {
    setPicking(false);
    setBusy('add');
    try {
      const p = await api.post<ProjectView>('/projects', { root });
      toast(`${p.name}: ${p.repos.length} repo${p.repos.length === 1 ? '' : 's'} found`, 'success');
      void list.reload();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const rescan = async (p: ProjectView) => {
    setBusy(p.id);
    try {
      await api.post(`/projects/${enc(p.id)}/rescan`, {});
      void list.reload();
    } catch (e: any) {
      toast(`Rescan failed: ${e?.message ?? e}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  const remove = async (p: ProjectView) => {
    if (!(await confirm({ title: `Remove ${p.name}?`, body: 'Monarch forgets this project. Nothing in the folder is touched.', confirmLabel: 'Remove', danger: true }))) return;
    await api.del(`/projects/${enc(p.id)}`).catch((e) => toast(String(e?.message ?? e), 'error'));
    void list.reload();
  };

  return (
    <div class="flex flex-col gap-4">
      {dialog}
      <Panel
        title="Projects"
        right={
          <Btn pill variant="primary" size="xs" loading={busy === 'add'} onClick={() => setPicking(true)}>
            <FolderOpen size={12} /> Add folder
          </Btn>
        }
      >
        <p class="text-[12.5px] text-fg-3 mb-3 leading-relaxed">
          Add the folder that holds a project's repos (for example backend, frontend and services side by side). Monarch finds every git repo up to two levels
          down and reads its own files (package.json, Makefile, go.mod, CI workflows, compose files, .env.example) to learn how to build, test and run it. Profiles
          refresh by themselves when a repo's commit changes. Nothing is written into your repos.
        </p>
        {list.loading && !list.data ? (
          <Skeleton lines={3} class="py-2" />
        ) : !list.data?.length ? (
          <EmptyState
            icon={<FolderGit2 size={18} strokeWidth={1.5} />}
            title="No projects yet"
            hint="Point Monarch at a folder with your repos. It learns how to build, test and run each one."
            actions={
              <Btn pill variant="primary" size="sm" onClick={() => setPicking(true)}>
                <FolderOpen size={13} /> Add folder
              </Btn>
            }
          />
        ) : (
          <div class="flex flex-col gap-4">
            {list.data.map((p) => (
              <div key={p.id} class="border border-line rounded-[var(--radius-control)]">
                <div class="flex items-center gap-2 px-3 py-2 border-b border-dashed border-line">
                  <FolderGit2 size={14} class="text-fg-3" />
                  <span class="text-[13px] text-fg">{p.name}</span>
                  <span class="font-mono text-[11px] text-fg-3 truncate">{p.root}</span>
                  <div class="ml-auto flex gap-1 shrink-0">
                    <button class="btn btn-ghost btn-xs text-fg-3 hover:text-fg" title="Re-detect every repo" disabled={busy === p.id} onClick={() => void rescan(p)}>
                      {busy === p.id ? <Spinner /> : <RefreshCw size={11} />}
                    </button>
                    <button class="btn btn-ghost btn-xs text-fg-3 hover:text-red" title="Remove project" onClick={() => void remove(p)}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                <ul class="divide-y divide-line">
                  {p.repos.map((r) => (
                    <RepoRow key={r.path} repo={r} root={p.root} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <DirBrowser open={picking} title="Choose the project folder" confirmLabel="Add project" onPick={(path) => void add(path)} onClose={() => setPicking(false)} />
    </div>
  );
}

function RepoRow(props: { repo: RepoProfile; root: string }) {
  const r = props.repo;
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState(r.checkSource === 'user' ? (r.check ?? '') : '');
  const rel = r.path === props.root ? '.' : r.path.slice(props.root.length + 1);

  const saveCheck = async () => {
    try {
      await api.put('/repos/check', { path: r.path, check });
      toast(check.trim() ? 'Check command saved' : 'Using the detected check command', 'success');
    } catch (e: any) {
      toast(`Not saved: ${e?.message ?? e}`, 'error');
    }
  };

  return (
    <li class="px-3 py-2">
      <button class="w-full flex items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight size={11} class={`text-fg-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span class="text-[12.5px] text-fg">{rel}</span>
        <span class="flex flex-wrap gap-1">
          {r.stack.slice(0, 4).map((s) => (
            <Tag key={s}>{s}</Tag>
          ))}
        </span>
        <span class="ml-auto font-mono text-[11px] text-fg-3 truncate max-w-[45%]" title={r.check ? `Check: ${r.check}` : 'No check command detected'}>
          {r.check ?? 'no check'}
        </span>
      </button>
      {open && (
        <div class="mt-2 ml-5 flex flex-col gap-1.5 text-[12px] text-fg-2">
          {r.readme && <div class="text-fg-3 leading-relaxed">{r.readme.slice(0, 240)}</div>}
          {Object.entries(r.commands).filter(([, v]) => v).length > 0 && (
            <div class="grid grid-cols-[80px_1fr] gap-x-2 gap-y-0.5">
              {Object.entries(r.commands)
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <Fragment key={k}>
                    <span class="text-fg-3">{k}</span>
                    <code class="font-mono text-[11.5px] text-fg truncate">{v}</code>
                  </Fragment>
                ))}
            </div>
          )}
          {r.ciCommands.length > 0 && (
            <div>
              <span class="text-fg-3">CI runs: </span>
              <code class="font-mono text-[11.5px]">{r.ciCommands.join('  ·  ')}</code>
            </div>
          )}
          {(r.ports.length > 0 || r.services.length > 0) && (
            <div class="text-fg-3">
              {r.services.length > 0 && <>Compose: {r.services.join(', ')}. </>}
              {r.ports.length > 0 && <>Ports: {r.ports.join(', ')}</>}
            </div>
          )}
          <div class="flex items-center gap-2 mt-1">
            <span class="text-fg-3 shrink-0">Check before done</span>
            <input class={`${INPUT} !h-7 font-mono !text-[12px]`} placeholder={r.checkSource === 'detected' ? r.check : 'e.g. npm run typecheck && npm test'} value={check} onInput={(e) => setCheck((e.target as HTMLInputElement).value)} />
            <Btn pill size="xs" onClick={() => void saveCheck()}>
              Save
            </Btn>
          </div>
          <div class="text-[11px] text-fg-3">
            Workers run this after editing files; a failure goes back to the worker (up to 2 fix rounds). Leave empty to use the detected command. Scanned at commit{' '}
            {r.head?.slice(0, 7) ?? '—'}
            {r.branch ? ` on ${r.branch}` : ''}.
          </div>
        </div>
      )}
    </li>
  );
}
