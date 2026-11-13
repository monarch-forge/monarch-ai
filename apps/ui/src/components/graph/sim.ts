/**
 * Lightweight force simulation (d3-force semantics, no deps):
 * link springs, many-body repulsion (Barnes–Hut for larger graphs), weak centering, velocity damping, cooling.
 * Nodes are plain mutable objects so positions survive data refreshes (reuse the same object per id).
 */

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** fixed position while dragging */
  fx?: number | null;
  fy?: number | null;
  /** repulsion strength multiplier (heavier nodes push more) */
  weight: number;
  /** visual radius in world units */
  r: number;
}

export interface SimLink {
  source: SimNode;
  target: SimNode;
  /** rest length */
  distance: number;
  strength: number;
  bias: number;
}

export interface SimOptions {
  charge: number; // negative = repulsion
  linkDistance: number;
  center: number; // pull toward origin
  velocityDecay: number; // 0..1 friction (fraction of velocity lost per tick)
  alphaDecay: number;
  alphaMin: number;
  theta: number;
  distanceMax: number;
}

const DEFAULTS: SimOptions = {
  charge: -60,
  linkDistance: 42,
  center: 0.045,
  velocityDecay: 0.42,
  alphaDecay: 1 - Math.pow(0.001, 1 / 320),
  alphaMin: 0.002,
  theta: 0.9,
  distanceMax: 900,
};

interface Quad {
  x0: number;
  y0: number;
  size: number;
  // aggregate
  cx: number;
  cy: number;
  w: number;
  bodies: SimNode[] | null; // leaf
  kids: (Quad | null)[] | null; // internal
}

export class ForceSim {
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  alpha = 1;
  alphaTarget = 0;
  opts: SimOptions;

  constructor(opts: Partial<SimOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  setData(nodes: SimNode[], links: { source: SimNode; target: SimNode }[]): void {
    this.nodes = nodes;
    const count = new Map<SimNode, number>();
    for (const l of links) {
      count.set(l.source, (count.get(l.source) ?? 0) + 1);
      count.set(l.target, (count.get(l.target) ?? 0) + 1);
    }
    this.links = links.map((l) => {
      const cs = count.get(l.source) ?? 1;
      const ct = count.get(l.target) ?? 1;
      return {
        source: l.source,
        target: l.target,
        distance: this.opts.linkDistance + Math.min(40, (l.source.r + l.target.r) * 1.5),
        strength: 1 / Math.min(cs, ct),
        bias: cs / (cs + ct),
      };
    });
  }

  get settled(): boolean {
    return this.alpha < this.opts.alphaMin && this.alphaTarget < this.opts.alphaMin;
  }

  reheat(alpha = 0.3): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  tick(iterations = 1): void {
    for (let k = 0; k < iterations; k++) {
      this.alpha += (this.alphaTarget - this.alpha) * this.opts.alphaDecay;
      this.applyLinks();
      this.applyCharge();
      this.applyCenter();
      const decay = 1 - this.opts.velocityDecay;
      for (const n of this.nodes) {
        if (n.fx != null) {
          n.x = n.fx;
          n.vx = 0;
        } else {
          n.vx *= decay;
          n.x += n.vx;
        }
        if (n.fy != null) {
          n.y = n.fy;
          n.vy = 0;
        } else {
          n.vy *= decay;
          n.y += n.vy;
        }
      }
    }
  }

  private applyLinks(): void {
    const alpha = this.alpha;
    for (const l of this.links) {
      const s = l.source;
      const t = l.target;
      let x = t.x + t.vx - s.x - s.vx || jiggle();
      let y = t.y + t.vy - s.y - s.vy || jiggle();
      let d = Math.sqrt(x * x + y * y);
      d = ((d - l.distance) / d) * alpha * l.strength;
      x *= d;
      y *= d;
      t.vx -= x * l.bias;
      t.vy -= y * l.bias;
      s.vx += x * (1 - l.bias);
      s.vy += y * (1 - l.bias);
    }
  }

  private applyCenter(): void {
    const k = this.opts.center * this.alpha;
    for (const n of this.nodes) {
      n.vx -= n.x * k;
      n.vy -= n.y * k;
    }
  }

  private applyCharge(): void {
    const nodes = this.nodes;
    const n = nodes.length;
    if (n < 2) return;
    const alpha = this.alpha;
    const strength = this.opts.charge;
    const dmax2 = this.opts.distanceMax * this.opts.distanceMax;

    if (n <= 320) {
      // exact O(n²)
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let x = b.x - a.x;
          let y = b.y - a.y;
          let l = x * x + y * y;
          if (l >= dmax2) continue;
          if (x === 0) (x = jiggle()), (l += x * x);
          if (y === 0) (y = jiggle()), (l += y * y);
          if (l < 1) l = Math.sqrt(l);
          // a is pushed by b's weight, b by a's
          const fa = (strength * b.weight * alpha) / l;
          const fb = (strength * a.weight * alpha) / l;
          a.vx += x * fa;
          a.vy += y * fa;
          b.vx -= x * fb;
          b.vy -= y * fb;
        }
      }
      return;
    }

    const root = buildQuadtree(nodes);
    const theta2 = this.opts.theta * this.opts.theta;
    const stack: Quad[] = [];
    for (const node of nodes) {
      stack.length = 0;
      stack.push(root);
      while (stack.length) {
        const q = stack.pop()!;
        if (!q.w) continue;
        let x = q.cx - node.x;
        let y = q.cy - node.y;
        let l = x * x + y * y;
        if (q.kids && (q.size * q.size) / theta2 < l) {
          // far enough: treat quad as one body
          if (l < dmax2) {
            if (x === 0) (x = jiggle()), (l += x * x);
            if (y === 0) (y = jiggle()), (l += y * y);
            if (l < 1) l = Math.sqrt(l);
            const f = (strength * q.w * alpha) / l;
            node.vx += x * f;
            node.vy += y * f;
          }
          continue;
        }
        if (q.kids) {
          for (const c of q.kids) if (c) stack.push(c);
          continue;
        }
        // leaf
        for (const b of q.bodies!) {
          if (b === node) continue;
          x = b.x - node.x;
          y = b.y - node.y;
          l = x * x + y * y;
          if (l >= dmax2) continue;
          if (x === 0) (x = jiggle()), (l += x * x);
          if (y === 0) (y = jiggle()), (l += y * y);
          if (l < 1) l = Math.sqrt(l);
          const f = (strength * b.weight * alpha) / l;
          node.vx += x * f;
          node.vy += y * f;
        }
      }
    }
  }
}

function jiggle(): number {
  return (Math.random() - 0.5) * 1e-6;
}

function buildQuadtree(nodes: SimNode[]): Quad {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.x > x1) x1 = n.x;
    if (n.y > y1) y1 = n.y;
  }
  const size = Math.max(x1 - x0, y1 - y0, 1) * 1.0001;
  const root: Quad = { x0, y0, size, cx: 0, cy: 0, w: 0, bodies: [], kids: null };
  for (const n of nodes) insert(root, n, 0);
  aggregate(root);
  return root;
}

function insert(q: Quad, n: SimNode, depth: number): void {
  if (!q.kids) {
    const bodies = q.bodies!;
    if (bodies.length === 0 || depth > 18 || q.size < 1e-3) {
      bodies.push(n);
      return;
    }
    // subdivide
    q.kids = [null, null, null, null];
    q.bodies = null;
    for (const b of bodies) insertChild(q, b, depth);
  }
  insertChild(q, n, depth);
}

function insertChild(q: Quad, n: SimNode, depth: number): void {
  const half = q.size / 2;
  const right = n.x >= q.x0 + half ? 1 : 0;
  const bottom = n.y >= q.y0 + half ? 1 : 0;
  const i = bottom * 2 + right;
  let c = q.kids![i];
  if (!c) {
    c = { x0: q.x0 + right * half, y0: q.y0 + bottom * half, size: half, cx: 0, cy: 0, w: 0, bodies: [], kids: null };
    q.kids![i] = c;
  }
  insert(c, n, depth + 1);
}

function aggregate(q: Quad): void {
  let w = 0,
    cx = 0,
    cy = 0;
  if (q.kids) {
    for (const c of q.kids) {
      if (!c) continue;
      aggregate(c);
      w += c.w;
      cx += c.cx * c.w;
      cy += c.cy * c.w;
    }
  } else {
    for (const b of q.bodies!) {
      w += b.weight;
      cx += b.x * b.weight;
      cy += b.y * b.weight;
    }
  }
  q.w = w;
  q.cx = w ? cx / w : q.x0 + q.size / 2;
  q.cy = w ? cy / w : q.y0 + q.size / 2;
}
