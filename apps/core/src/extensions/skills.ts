/**
 * Skills: learned procedures stored as paths.skills/<id>.md
 *
 *   ---
 *   name: Weekly review
 *   description: Close out the week: tasks, calendar, inbox
 *   origin: user
 *   uses: 3
 *   updatedAt: 2026-11-14T10:00:00.000Z
 *   ---
 *   markdown body…
 *
 * Names + descriptions are listed in the system prompt (skillsPromptContext); the agent reads the body with skill_read.
 */
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill, SkillSummary } from '@monarch/shared';
import { changed, HttpError, nowIso, paths } from '../kernel.ts';
import { ID_RE } from './store.ts';

const file = (id: string) => join(paths.skills, `${id}.md`);

function checkId(id: string): string {
  const s = String(id ?? '').trim();
  if (!ID_RE.test(s) || s.length > 64) throw new HttpError(400, `skill id "${s}" must be kebab-case (e.g. "weekly-review")`);
  return s;
}

/** "Weekly Review!" → "weekly-review" */
export function skillIdFrom(name: string): string {
  return (
    String(name ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'skill'
  );
}

function parse(id: string, raw: string): Skill {
  const meta: Record<string, string> = {};
  let body = raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!kv) continue;
      let v = kv[2].trim();
      if (/^".*"$/.test(v)) {
        try {
          v = JSON.parse(v);
        } catch {
          v = v.slice(1, -1);
        }
      }
      meta[kv[1]] = v;
    }
  }
  return {
    id,
    name: meta.name || id,
    description: meta.description || '',
    origin: meta.origin === 'agent' ? 'agent' : 'user',
    updatedAt: meta.updatedAt || nowIso(),
    uses: Number(meta.uses) || 0,
    body: body.replace(/^\s*\n/, ''),
  };
}

const q = (v: string) => (/^[\w .,()/'&+-]*$/.test(v) && !/^\s|\s$/.test(v) ? v : JSON.stringify(v));

function serialize(s: Skill): string {
  return [
    '---',
    `name: ${q(s.name)}`,
    `description: ${q(s.description)}`,
    `origin: ${s.origin}`,
    `uses: ${s.uses}`,
    `updatedAt: ${s.updatedAt}`,
    '---',
    '',
    s.body.trimEnd(),
    '',
  ].join('\n');
}

function save(s: Skill): void {
  const f = file(s.id);
  writeFileSync(`${f}.tmp`, serialize(s));
  renameSync(`${f}.tmp`, f);
}

const summary = ({ body: _b, ...rest }: Skill): SkillSummary => rest;

export function listSkills(): SkillSummary[] {
  if (!existsSync(paths.skills)) return [];
  const out: SkillSummary[] = [];
  for (const f of readdirSync(paths.skills)) {
    if (!f.endsWith('.md')) continue;
    const id = f.slice(0, -3);
    if (!ID_RE.test(id)) continue;
    try {
      out.push(summary(parse(id, readFileSync(join(paths.skills, f), 'utf8'))));
    } catch {
      /* unreadable file */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(id: string): Skill {
  const sid = checkId(id);
  if (!existsSync(file(sid))) throw new HttpError(404, `skill "${sid}" not found`);
  return parse(sid, readFileSync(file(sid), 'utf8'));
}

/** read for use by the agent (counts a use) */
export function readSkill(id: string): Skill {
  const s = getSkill(id);
  s.uses += 1;
  save(s); // keeps updatedAt: it tracks content changes, not reads
  changed('skills');
  return s;
}

export function writeSkill(
  id: string,
  input: { name?: string; description?: string; body?: string },
  origin: Skill['origin'],
): { skill: Skill; created: boolean } {
  const sid = checkId(id);
  const prev = existsSync(file(sid)) ? parse(sid, readFileSync(file(sid), 'utf8')) : null;
  const name = String(input.name ?? prev?.name ?? '').trim();
  const description = String(input.description ?? prev?.description ?? '').trim().replace(/\s+/g, ' ');
  const body = String(input.body ?? prev?.body ?? '');
  if (!name) throw new HttpError(400, 'skill name is required');
  if (!description) throw new HttpError(400, 'skill description is required (one line: when to use it)');
  if (!body.trim()) throw new HttpError(400, 'skill body is required');
  if (body.length > 64_000) throw new HttpError(400, 'skill body is too long (max 64 KB)');
  const skill: Skill = {
    id: sid,
    name: name.slice(0, 80),
    description: description.slice(0, 300),
    origin: prev?.origin ?? origin,
    uses: prev?.uses ?? 0,
    updatedAt: nowIso(),
    body,
  };
  save(skill);
  changed('skills');
  return { skill, created: !prev };
}

export function deleteSkill(id: string): Skill {
  const s = getSkill(id);
  unlinkSync(file(s.id));
  changed('skills');
  return s;
}

/** compact markdown list for the system prompt; '' when there are no skills */
export function skillsPromptContext(): string {
  const list = listSkills().sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));
  if (!list.length) return '';
  const lines: string[] = [];
  let size = 0;
  for (const s of list.slice(0, 40)) {
    const line = `- **${s.name}** (\`${s.id}\`) — ${s.description}`;
    if (size + line.length > 2500) break;
    lines.push(line);
    size += line.length + 1;
  }
  const rest = list.length - lines.length;
  if (rest > 0) lines.push(`- …and ${rest} more (skill_list)`);
  return lines.join('\n');
}
