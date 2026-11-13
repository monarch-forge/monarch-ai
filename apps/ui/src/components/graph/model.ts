/** Pure graph helpers: filtering (tags / ghosts / local neighbourhood) and lookups. */
import type { MemoryGraph } from '@monarch/shared';

export type GNode = MemoryGraph['nodes'][number];
export type GEdge = MemoryGraph['edges'][number];

export interface GraphView {
  nodes: GNode[];
  edges: GEdge[];
  /** true when local mode was requested and the focus node exists in the graph */
  local: boolean;
}

export interface FilterOpts {
  showTags: boolean;
  showGhosts: boolean;
  /** restrict to the neighbourhood of this node id */
  localId?: string | null;
  depth?: number;
}

/** sanitize server data: drop malformed nodes and dangling / duplicate edges */
export function normalizeGraph(g: MemoryGraph | undefined | null): MemoryGraph {
  const nodes: GNode[] = [];
  const seen = new Set<string>();
  for (const n of Array.isArray(g?.nodes) ? g!.nodes : []) {
    if (!n || typeof n.id !== 'string' || seen.has(n.id)) continue;
    seen.add(n.id);
    nodes.push({
      id: n.id,
      title: typeof n.title === 'string' && n.title ? n.title : n.id,
      tags: Array.isArray(n.tags) ? n.tags : [],
      degree: Number.isFinite(n.degree) ? n.degree : 0,
      kind: n.kind === 'tag' || n.kind === 'ghost' ? n.kind : 'note',
    });
  }
  const edges: GEdge[] = [];
  const ek = new Set<string>();
  for (const e of Array.isArray(g?.edges) ? g!.edges : []) {
    if (!e || !seen.has(e.source) || !seen.has(e.target) || e.source === e.target) continue;
    const k = e.source < e.target ? `${e.source}\u0001${e.target}` : `${e.target}\u0001${e.source}`;
    if (ek.has(k)) continue;
    ek.add(k);
    edges.push({ source: e.source, target: e.target, kind: e.kind === 'tag' ? 'tag' : 'link' });
  }
  return { nodes, edges };
}

export function filterGraph(g: MemoryGraph, o: FilterOpts): GraphView {
  let nodes = g.nodes.filter((n) => (n.kind === 'tag' ? o.showTags : n.kind === 'ghost' ? o.showGhosts : true));
  let ids = new Set(nodes.map((n) => n.id));
  let edges = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  let local = false;
  if (o.localId && ids.has(o.localId)) {
    local = true;
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      // in local mode, don't traverse *through* tag nodes (they'd pull in half the vault)
      (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
      (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
    }
    const kind = new Map(nodes.map((n) => [n.id, n.kind]));
    const keep = new Set<string>([o.localId]);
    let frontier = [o.localId];
    for (let d = 0; d < (o.depth ?? 2); d++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (id !== o.localId && kind.get(id) === 'tag') continue;
        for (const nb of adj.get(id) ?? []) {
          if (!keep.has(nb)) {
            keep.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    nodes = nodes.filter((n) => keep.has(n.id));
    ids = keep;
    edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }
  return { nodes, edges, local };
}

/** resolve a [[wikilink]] target to a node id (exact id, title, or trailing path segment; case-insensitive) */
export function resolveLink(target: string, nodes: { id: string; title: string; kind?: string }[]): string | null {
  const t = target.trim().replace(/\.md$/i, '');
  if (!t) return null;
  const lower = t.toLowerCase();
  let hit = nodes.find((n) => n.kind !== 'ghost' && n.kind !== 'tag' && n.id === t);
  hit ??= nodes.find((n) => n.kind !== 'ghost' && n.kind !== 'tag' && n.id.toLowerCase() === lower);
  hit ??= nodes.find((n) => n.kind !== 'ghost' && n.kind !== 'tag' && n.title.toLowerCase() === lower);
  hit ??= nodes.find((n) => n.kind !== 'ghost' && n.kind !== 'tag' && n.id.toLowerCase().endsWith('/' + lower));
  return hit ? hit.id : null;
}
