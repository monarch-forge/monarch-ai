import { useMemo } from 'preact/hooks';
import { renderMarkdown } from '../../lib/markdown.ts';
import { openExternal } from '../../lib/api.ts';
import { toast } from '../../lib/store.ts';

export async function copyText(text: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'success');
  } catch {
    toast('Clipboard unavailable', 'warn');
  }
}

/** click delegation for rendered markdown: external links + code copy buttons */
function onMdClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return;
  const copy = t.closest<HTMLElement>('[data-copy]');
  if (copy) {
    e.preventDefault();
    const code = copy.closest('.md-code')?.querySelector('code')?.textContent ?? '';
    void copyText(code, 'Code copied');
    copy.textContent = 'copied';
    window.setTimeout(() => (copy.textContent = 'copy'), 1200);
    return;
  }
  const a = t.closest<HTMLAnchorElement>('a[data-ext]');
  if (a) {
    e.preventDefault();
    void openExternal(a.href);
  }
}

export function Markdown(props: { text: string; caret?: boolean; class?: string }) {
  const html = useMemo(() => renderMarkdown(props.text, { caret: props.caret }), [props.text, props.caret]);
  return <div class={`md text-fg ${props.class ?? ''}`} onClick={onMdClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
