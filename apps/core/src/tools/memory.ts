/** Memory vault tools (Core-C) — Obsidian-compatible markdown notes. */
import { z } from 'zod';
import { defineTool, type ToolDef } from '../kernel.ts';
import { appendNote, deleteNote, getNote, linkNotes, noteExists, putNote, recentNotes, searchNotes } from '../integrations/memory/index.ts';
import type { MemoryNoteSummary } from '@monarch/shared';

function fmtSummary(n: MemoryNoteSummary): string {
  return `• ${n.title}${n.id !== n.title ? ` [${n.id}]` : ''}${n.tags.length ? ` #${n.tags.join(' #')}` : ''} — updated ${n.updatedAt.slice(0, 10)}${n.excerpt ? `\n  ${n.excerpt}` : ''}`;
}

const memorySearch = defineTool({
  name: 'memory_search',
  loading: 'always',
  group: 'memory',
  keywords: ['vault', 'notes', 'remember', 'recall', 'knowledge', 'obsidian'],
  description: [
    "Search Monarch's long-term memory (the user's markdown vault) by keywords. Ranks title matches, tags and body text.",
    'Use "#tag" terms to filter by tag (e.g. "#person pepper", "#project"). Search memory before asking the user for facts they may have told you before (people, preferences, projects).',
  ].join(' '),
  risk: 'safe',
  tag: 'MEM',
  schema: z.object({
    query: z.string().describe('Keywords and/or #tags.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
  }),
  summarize: (i) => `Search memory: ${i.query}`,
  run: async (i) => {
    const r = await searchNotes(i.query, i.limit ?? 10);
    return r.length ? r.map(fmtSummary).join('\n') : `No notes match "${i.query}".`;
  },
});

const memoryRead = defineTool({
  name: 'memory_read',
  loading: 'always',
  group: 'memory',
  keywords: ['vault', 'note', 'obsidian'],
  description: 'Read a memory note in full (markdown body, tags, outgoing [[links]] and backlinks). `note` is a note id/path like "People/Pepper Potts" or just its title.',
  risk: 'safe',
  tag: 'MEM',
  schema: z.object({ note: z.string().describe('Note id (relative path without .md) or title.') }),
  summarize: (i) => `Read note ${i.note}`,
  run: async (i) => {
    const n = await getNote(i.note);
    return [
      `# ${n.title}  [id: ${n.id}]`,
      `tags: ${n.tags.length ? n.tags.map((t) => `#${t}`).join(' ') : '—'} · source: ${n.source} · updated ${n.updatedAt}`,
      n.links.length ? `links → ${n.links.map((l) => `[[${l}]]`).join(', ')}` : '',
      n.backlinks.length ? `backlinks ← ${n.backlinks.map((l) => `[[${l}]]`).join(', ')}` : '',
      '',
      n.body.trim() || '(empty)',
    ]
      .filter((l, idx) => l !== '' || idx === 4)
      .join('\n');
  },
});

const memoryWrite = defineTool({
  name: 'memory_write',
  loading: 'always',
  group: 'memory',
  keywords: ['vault', 'note', 'remember', 'save fact', 'obsidian'],
  description: [
    "Remember something in the user's long-term memory vault (markdown, Obsidian-compatible). Use it freely and proactively whenever you learn durable facts:",
    'preferences, people and relationships, projects, decisions, recurring context. Keep notes concise and factual; link related notes with [[Note Name]] and use #tags.',
    'Conventions: People/<Name> for people (#person), Projects/<Name> (#project), Notes/<Topic> for everything else; facts about the user go in "People/Me". Tag a note #pinned only if it must be in context for every conversation.',
    'mode "append" (default) adds the content to the end of the note (creating it if missing); mode "replace" overwrites the body — read the note first so nothing is lost.',
  ].join(' '),
  risk: 'safe',
  tag: 'MEM',
  schema: z.object({
    note: z.string().describe('Note id/path (e.g. "People/Pepper Potts", "Projects/Mark 42") or the title of an existing note.'),
    content: z.string().min(1).describe('Markdown to write. May contain [[wikilinks]] and #tags.'),
    mode: z.enum(['append', 'replace']).optional().describe('append (default) or replace.'),
    tags: z.array(z.string()).optional().describe('Tags to add (without #), e.g. ["person", "work"].'),
    title: z.string().optional().describe('Display title if it should differ from the file name (new notes only).'),
  }),
  summarize: (i) => `${i.mode === 'replace' ? 'Rewrite' : 'Remember in'} note ${i.note}`,
  run: async (i) => {
    const mode = i.mode ?? 'append';
    const existingId = await noteExists(i.note);
    let n;
    if (mode === 'replace') {
      let tags = i.tags;
      if (existingId && i.tags) {
        const cur = await getNote(existingId);
        tags = [...cur.tags, ...i.tags];
      }
      n = await putNote(existingId ?? i.note, { title: i.title, body: i.content, tags, source: 'agent' });
    } else {
      n = await appendNote(existingId ?? i.note, i.content, { tags: i.tags, title: i.title, source: 'agent' });
    }
    return `${existingId ? (mode === 'replace' ? 'Replaced' : 'Appended to') : 'Created'} note "${n.title}" [${n.id}]${n.tags.length ? ` #${n.tags.join(' #')}` : ''}.`;
  },
});

const memoryLink = defineTool({
  name: 'memory_link',
  group: 'memory',
  keywords: ['vault', 'wikilink', 'backlink', 'relate notes'],
  description:
    'Link two memory notes: appends "- [[to]] — context" under a "## Related" section of the `from` note (no-op if already linked). The target may not exist yet (it becomes an unresolved link until written).',
  risk: 'safe',
  tag: 'MEM',
  schema: z.object({
    from: z.string().describe('Existing note id or title to add the link to.'),
    to: z.string().describe('Target note id or title.'),
    context: z.string().optional().describe('Short description of the relationship, e.g. "sister", "client of".'),
  }),
  summarize: (i) => `Link note ${i.from} → ${i.to}`,
  run: async (i) => {
    const r = await linkNotes(i.from, i.to, i.context, 'agent');
    if (r.alreadyLinked) return `"${r.note.title}" already links to ${i.to}.`;
    return `Linked "${r.note.title}" → [[${i.to}]]${r.targetExists ? '' : ' (target note does not exist yet)'}.`;
  },
});

const memoryListRecent = defineTool({
  name: 'memory_list_recent',
  group: 'memory',
  keywords: ['vault', 'recent notes'],
  description: 'List the most recently updated memory notes (title, id, tags, excerpt).',
  risk: 'safe',
  tag: 'MEM',
  schema: z.object({ limit: z.number().int().min(1).max(50).optional().describe('How many (default 10).') }),
  run: async (i) => {
    const r = await recentNotes(i.limit ?? 10);
    return r.length ? r.map(fmtSummary).join('\n') : 'The memory vault is empty.';
  },
});

const memoryDelete = defineTool({
  name: 'memory_delete',
  group: 'memory',
  keywords: ['vault', 'remove note', 'forget'],
  description: "Delete a memory note (moved to the vault's .trash folder, recoverable). Only when the user asks or a note is clearly wrong/duplicated.",
  risk: 'sensitive',
  tag: 'MEM',
  schema: z.object({ note: z.string().describe('Note id or title.') }),
  summarize: (i) => `Delete memory note ${i.note}`,
  run: async (i) => {
    const r = await deleteNote(i.note);
    return `Deleted "${r.id}" (moved to ${r.trashedTo}).`;
  },
});

export const tools: ToolDef[] = [memorySearch, memoryRead, memoryWrite, memoryLink, memoryListRecent, memoryDelete] as unknown as ToolDef[];
