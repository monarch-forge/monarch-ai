/** Overview bottom-centre: FLG.07 flagged items + open tasks / unread mail. OWNED BY UI-A. */
import type { Briefing } from '@monarch/shared';
import { navigate, type Resource } from '../../lib/store.ts';
import { Panel, Tag, fmt, useNow } from '../ui.tsx';
import { Gate, PanelNote } from './common.tsx';

export function FlagsPanel(props: { res: Resource<Briefing>; class?: string }) {
  const b = props.res.data;
  const flags = b?.flags ?? [];
  const hot = flags.filter((f) => f.level !== 'info').length;
  return (
    <Panel
      code="FLG.07"
      title="Flagged"
      class={props.class}
      active={hot > 0}
      noPad
      bodyClass="flex"
      right={b ? <Tag tone={hot ? 'red' : 'plain'}>{flags.length ? `${flags.length} active` : 'All clear'}</Tag> : undefined}
    >
      <Gate res={props.res}>
        {(br) => (
          <div class="flex-1 min-w-0 grid grid-cols-[1fr_168px]">
            <div class="min-h-0 overflow-y-auto px-2 py-1.5 border-r border-line">
              {(br.flags ?? []).length === 0 ? (
                <PanelNote label="Nothing flagged" sub="No items need your attention." />
              ) : (
                (br.flags ?? []).map((f, i) => {
                  const body = (
                    <>
                      <span class={`inline-block w-1.5 h-1.5 shrink-0 ${f.level === 'error' ? 'bg-red' : f.level === 'warn' ? 'bg-warning' : 'bg-fg-3'}`} />
                      <span class={`font-mono text-[10.5px] tracking-[0.06em] w-9 shrink-0 ${f.level === 'error' ? 'text-red' : 'text-fg-3'}`}>{f.tag}</span>
                      <span class={`flex-1 min-w-0 truncate ${f.level === 'info' ? 'text-fg-2' : 'text-fg'}`}>{f.text}</span>
                      {f.href && <span class="font-mono text-[10px] text-fg-3">→</span>}
                    </>
                  );
                  return f.href ? (
                    <a key={i} href={f.href} class="hud-row !py-1.5" title={f.text}>
                      {body}
                    </a>
                  ) : (
                    <div key={i} class="hud-row !py-1.5" title={f.text}>
                      {body}
                    </div>
                  );
                })
              )}
            </div>
            <div class="flex flex-col divide-y divide-line">
              <Counter label="Open tasks" value={br.openTasks} onClick={() => navigate('agenda')} />
              <Counter label="Unread mail" value={br.unreadMail} onClick={() => navigate('mail')} attention={br.unreadMail > 0} />
              <NextEvent br={br} />
            </div>
          </div>
        )}
      </Gate>
    </Panel>
  );
}

function Counter(props: { label: string; value: number | undefined; onClick: () => void; attention?: boolean }) {
  return (
    <button type="button" class="flex-1 flex items-center justify-between gap-2 px-3.5 py-1.5 text-left hover:bg-white/[0.02] group" onClick={props.onClick}>
      <span class="hud-label text-[10px] group-hover:text-fg-2">{props.label}</span>
      <span class="flex items-center gap-2">
        <span class={`hud-value text-[18px] font-light ${props.attention ? 'text-fg' : 'text-fg-2'}`}>{typeof props.value === 'number' ? props.value : '—'}</span>
        <span class="font-mono text-[10px] text-fg-3 group-hover:text-fg-2">→</span>
      </span>
    </button>
  );
}

function NextEvent(props: { br: Briefing }) {
  const now = useNow(1000);
  const e = props.br.nextEvent;
  return (
    <button type="button" class="flex-1 flex flex-col justify-center gap-0.5 px-3.5 py-1.5 text-left hover:bg-white/[0.02] min-w-0" onClick={() => navigate('agenda')}>
      <span class="flex items-center justify-between gap-2">
        <span class="hud-label text-[10px]">Next</span>
        {e && <span class="hud-value text-[10.5px] text-fg-2">{fmt.countdown(e.start, now)}</span>}
      </span>
      <span class="text-[11.5px] text-fg-2 truncate">{e ? e.title : 'No upcoming events'}</span>
    </button>
  );
}
