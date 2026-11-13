/**
 * Dev affordance: a generated vault graph so the graph view can be exercised without a core.
 * Enabled by `?demo=1` (or `?demo=<nodeCount>`) in the page URL (before the hash).
 */
import type { MemoryGraph } from '@monarch/shared';

export function demoRequested(): number | null {
  const v = new URLSearchParams(location.search).get('demo');
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? Math.min(3000, n) : 140;
}

const AREAS = ['People', 'Projects', 'Daily', 'Ideas', 'Places', 'Reference'];
const WORDS = ['Arc', 'Mark', 'Forge', 'Atlas', 'Pepper', 'Happy', 'Rhodes', 'Vision', 'Malibu', 'Expo', 'Reactor', 'Palladium', 'Suit', 'Board', 'Gala', 'Lab', 'Drone', 'Satellite', 'Thruster', 'Q3', 'Energy', 'Charity', 'Keynote', 'Workshop'];
const TAGS = ['person', 'project', 'idea', 'meeting', 'todo', 'research', 'travel', 'finance'];

export function demoGraph(n = 140, seed = 7): MemoryGraph {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const nodes: MemoryGraph['nodes'] = [];
  const edges: MemoryGraph['edges'] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    let title = `${pick(WORDS)} ${pick(WORDS)}`;
    while (used.has(title)) title = `${title} ${i}`;
    used.add(title);
    const tags = rnd() < 0.7 ? [pick(TAGS)] : [];
    nodes.push({ id: `${pick(AREAS)}/${title}`, title, tags, degree: 0, kind: 'note' });
  }
  // preferential attachment → hubs + clusters
  for (let i = 1; i < n; i++) {
    const k = 1 + Math.floor(rnd() * 2.2);
    for (let j = 0; j < k; j++) {
      const t = rnd() < 0.6 ? Math.floor(rnd() * Math.min(i, 8)) : Math.floor(rnd() * i);
      edges.push({ source: nodes[i].id, target: nodes[t].id, kind: 'link' });
    }
  }
  // ghosts (links to notes that don't exist yet)
  for (let i = 0; i < Math.max(3, n / 20); i++) {
    const id = `Unwritten ${pick(WORDS)} ${i}`;
    nodes.push({ id, title: id, tags: [], degree: 0, kind: 'ghost' });
    edges.push({ source: nodes[Math.floor(rnd() * n)].id, target: id, kind: 'link' });
  }
  for (const t of TAGS) nodes.push({ id: `#${t}`, title: `#${t}`, tags: [], degree: 0, kind: 'tag' });
  for (const nd of nodes.slice(0, n)) for (const t of nd.tags) edges.push({ source: nd.id, target: `#${t}`, kind: 'tag' });
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  for (const nd of nodes) nd.degree = deg.get(nd.id) ?? 0;
  return { nodes, edges };
}

/** demo note body for a demo node id (so the drawer has something to show) */
export function demoNoteBody(id: string, g: MemoryGraph): string {
  const out = g.edges.filter((e) => e.source === id && e.kind === 'link').map((e) => e.target);
  return `# ${id.split('/').pop()}\n\nGenerated demo note. Links: ${out.map((t) => `[[${t}]]`).join(', ') || '—'}\n\n- [ ] follow up\n- [x] **seeded** by \`demo\` mode #demo`;
}
