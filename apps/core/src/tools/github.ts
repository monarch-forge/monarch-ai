/** GitHub PR tools via the `gh` CLI (all deferred). */
import { resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, type ToolDef } from '../kernel.ts';
import { createPr, diffPr, listPrs, reviewPr, viewPr } from '../integrations/github.ts';

const prArg = z.string().min(1).describe('PR url (or number when the session dir is the repo)');

const ghPrs = defineTool({
  name: 'gh_prs',
  group: 'github',
  keywords: ['pull requests', 'code review', 'ci'],
  description: 'Open GitHub PRs needing me: review requested, mine (with CI state), assigned.',
  risk: 'safe',
  tag: 'CODE',
  schema: z.object({}),
  async run() {
    const prs = await listPrs();
    if (!prs.length) return 'No open PRs need you.';
    return prs.map((p) => `[${p.reason}] ${p.repo}#${p.number} ${p.title}${p.draft ? ' (draft)' : ''} · @${p.author} · CI ${p.ci ?? 'none'} · ${p.url}`).join('\n');
  },
});

const ghPrView = defineTool({
  name: 'gh_pr_view',
  group: 'github',
  keywords: ['pull request', 'checks'],
  description: 'Show a PR: title, body, branches, files, checks.',
  risk: 'safe',
  tag: 'CODE',
  schema: z.object({ pr: prArg }),
  run: (i, ctx) => viewPr(i.pr, ctx.cwd || undefined),
});

const ghPrDiff = defineTool({
  name: 'gh_pr_diff',
  group: 'github',
  keywords: ['pull request', 'patch'],
  description: 'Unified diff of a PR (truncated).',
  risk: 'safe',
  tag: 'CODE',
  schema: z.object({ pr: prArg, max_chars: z.number().int().min(1000).max(200_000).optional() }),
  run: (i, ctx) => diffPr(i.pr, i.max_chars, ctx.cwd || undefined),
});

const ghPrCreate = defineTool({
  name: 'gh_pr_create',
  group: 'github',
  keywords: ['open pull request', 'push branch'],
  description: 'Push the current branch of a repo dir and open a GitHub PR (non-interactive). Returns the PR url.',
  risk: 'dangerous',
  tag: 'CODE',
  schema: z.object({
    title: z.string().min(1),
    body: z.string().describe('PR description (markdown)'),
    base: z.string().optional().describe('Base branch, default: repo default'),
    dir: z.string().optional().describe('Repo dir, default: session dir'),
    draft: z.boolean().optional(),
  }),
  summarize: (i) => `Open PR "${i.title}"${i.base ? ` → ${i.base}` : ''}${i.dir ? ` from ${i.dir}` : ''}`,
  run: (i, ctx) => createPr(resolve(ctx.cwd || process.cwd(), i.dir ?? '.'), i),
});

const ghPrReview = defineTool({
  name: 'gh_pr_review',
  group: 'github',
  keywords: ['approve', 'request changes', 'review comment'],
  description: 'Post a PR review (comment/approve/request-changes), optional inline comments. Only when the user asked to post.',
  risk: 'dangerous',
  tag: 'CODE',
  schema: z.object({
    pr: z.string().min(1).describe('PR url'),
    event: z.enum(['comment', 'approve', 'request-changes']),
    body: z.string().min(1),
    comments: z.array(z.object({ path: z.string(), line: z.number().int().min(1), body: z.string().min(1) })).optional().describe('Inline comments on new-file lines'),
  }),
  summarize: (i) => `Post ${i.event} review on ${i.pr}${i.comments?.length ? ` (+${i.comments.length} inline)` : ''}:\n${i.body.length > 1200 ? `${i.body.slice(0, 1199)}…` : i.body}`,
  run: (i) => reviewPr(i.pr, i.event, i.body, i.comments),
});

export const tools: ToolDef[] = [ghPrs, ghPrView, ghPrDiff, ghPrCreate, ghPrReview];
