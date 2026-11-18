/**
 * GitHub pull requests via the user's own `gh` CLI (auth comes from `gh auth login`).
 * Everything runs non-interactively: no TTY exists for the core, so interactive prompts would hang/fail.
 * shortcut: GitHub only; add `glab` (GitLab MRs) when someone needs it.
 */
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../services/sync.ts';

export const NO_PROMPT_ENV = { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' };

export interface GhPr {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  draft: boolean;
  updatedAt: string;
  /** SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | null (no checks) */
  ci: string | null;
  reason: 'review' | 'mine' | 'assigned';
}

async function gh(args: string[], cwd?: string, timeoutMs = 60_000): Promise<string> {
  const r = await run('gh', args, { cwd, env: NO_PROMPT_ENV, timeoutMs });
  if (r.code === -1 && /ENOENT/.test(r.stderr)) throw new Error('GitHub CLI `gh` not installed');
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh exited with ${r.code}`);
  return r.stdout;
}

const PR_FIELDS = `... on PullRequest { number title url isDraft updatedAt repository { nameWithOwner } author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;
const INBOX_QUERY = `query {
  review: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 30) { nodes { ${PR_FIELDS} } }
  mine: search(query: "is:pr is:open archived:false author:@me", type: ISSUE, first: 30) { nodes { ${PR_FIELDS} } }
  assigned: search(query: "is:pr is:open archived:false assignee:@me", type: ISSUE, first: 30) { nodes { ${PR_FIELDS} } }
}`;

/** Flatten the GraphQL inbox response; a PR in several buckets keeps the first (review > mine > assigned). */
export function parseInbox(json: any): GhPr[] {
  const seen = new Set<string>();
  const out: GhPr[] = [];
  for (const reason of ['review', 'mine', 'assigned'] as const) {
    for (const n of json?.data?.[reason]?.nodes ?? []) {
      if (!n?.url || seen.has(n.url)) continue;
      seen.add(n.url);
      out.push({
        number: n.number,
        title: n.title,
        url: n.url,
        repo: n.repository?.nameWithOwner ?? '',
        author: n.author?.login ?? '',
        draft: !!n.isDraft,
        updatedAt: n.updatedAt,
        ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
        reason,
      });
    }
  }
  return out;
}

export async function listPrs(): Promise<GhPr[]> {
  return parseInbox(JSON.parse(await gh(['api', 'graphql', '-f', `query=${INBOX_QUERY}`])));
}

export async function viewPr(pr: string, cwd?: string): Promise<string> {
  const j = JSON.parse(
    await gh(['pr', 'view', pr, '--json', 'title,body,url,state,author,baseRefName,headRefName,reviewDecision,files,statusCheckRollup'], cwd),
  );
  const checks = (j.statusCheckRollup ?? []).map((c: any) => `${c.name || c.context}: ${c.conclusion || c.state || c.status}`);
  const files = (j.files ?? []).map((f: any) => `${f.path} (+${f.additions}/-${f.deletions})`);
  return [
    `${j.title} — ${j.url}`,
    `${j.state} · by ${j.author?.login} · ${j.headRefName} → ${j.baseRefName} · review: ${j.reviewDecision || 'none'}`,
    `Checks: ${checks.join('; ') || 'none'}`,
    `Files (${files.length}):\n${files.slice(0, 100).join('\n')}`,
    `\n${(j.body || '(no description)').slice(0, 6000)}`,
  ].join('\n');
}

export async function diffPr(pr: string, max = 30_000, cwd?: string): Promise<string> {
  const d = await gh(['pr', 'diff', pr], cwd);
  return d.length > max ? `${d.slice(0, max)}\n… (diff truncated, ${d.length} chars total)` : d || '(empty diff)';
}

/** Push the current branch and open a PR from `dir`. Returns the PR url. */
export async function createPr(dir: string, o: { title: string; body: string; base?: string; draft?: boolean }): Promise<string> {
  const br = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, env: NO_PROMPT_ENV, timeoutMs: 15_000 });
  const head = br.stdout.trim();
  if (br.code !== 0 || !head || head === 'HEAD') throw new Error(`Not on a branch in ${dir}: ${br.stderr.trim()}`);
  if (o.base && o.base === head) throw new Error(`Head branch ${head} equals base; create a feature branch first`);
  const push = await run('git', ['push', '-u', 'origin', 'HEAD'], { cwd: dir, env: NO_PROMPT_ENV, timeoutMs: 180_000 });
  if (push.code !== 0) throw new Error(`git push failed: ${(push.stderr || push.stdout).trim()}`);
  const args = ['pr', 'create', '--title', o.title, '--body', o.body, '--head', head];
  if (o.base) args.push('--base', o.base);
  if (o.draft) args.push('--draft');
  return (await gh(args, dir, 120_000)).trim();
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/** Post a review. Inline comments go through the REST reviews API (one review, one notification). */
export async function reviewPr(pr: string, event: 'comment' | 'approve' | 'request-changes', body: string, comments: InlineComment[] = []): Promise<string> {
  if (!comments.length) {
    await gh(['pr', 'review', pr, `--${event}`, '--body', body]);
    return `Review (${event}) posted on ${pr}`;
  }
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pr);
  if (!m) throw new Error('Inline comments need a full PR url (https://github.com/o/r/pull/N)');
  const file = join(tmpdir(), `monarch-review-${process.pid}-${Date.now()}.json`);
  const payload = { body, event: { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' }[event], comments: comments.map((c) => ({ ...c, side: 'RIGHT' })) };
  await fsp.writeFile(file, JSON.stringify(payload), { mode: 0o600 });
  try {
    await gh(['api', '-X', 'POST', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/reviews`, '--input', file]);
  } finally {
    await fsp.rm(file, { force: true });
  }
  return `Review (${event}) with ${comments.length} inline comment(s) posted on ${pr}`;
}
