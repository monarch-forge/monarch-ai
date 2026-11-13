/**
 * Canvas force-directed graph (Obsidian-like) for the memory vault.
 * Imperative engine (GraphEngine) + thin Preact wrapper (GraphCanvas).
 * Pan: drag background · Zoom: wheel (around cursor) / + − · Fit: 0 or double-click · Drag nodes · Click opens.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { Minus, Plus, Scan } from 'lucide-preact';
import { ForceSim, type SimNode } from './sim.ts';
import type { GEdge, GNode, GraphView } from './model.ts';

const C = {
  note: '#9E9EA4',
  noteHi: '#F4F4F6',
  tag: '#5E5E64',
  ghost: '#5E5E64',
  edge: '#3C3C41',
  edgeHi: '#9E9EA4',
  red: '#D71921',
  label: '#9E9EA4',
  labelHi: '#F4F4F6',
  bg: '#121213',
};
const FONT = '10px "Geist Mono Variable", ui-monospace, monospace';

interface VNode {
  g: GNode;
  s: SimNode;
}
interface VEdge {
  a: VNode;
  b: VNode;
  kind: GEdge['kind'];
}

export interface GraphStats {
  nodes: number;
  edges: number;
}

type Hover = { id: string; title: string; kind: GNode['kind']; degree: number } | null;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class GraphEngine {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 1;
  private h = 1;
  private sim = new ForceSim();
  /** persistent positions by node id (survive filter toggles + data refreshes) */
  private pos = new Map<string, SimNode>();
  private nodes: VNode[] = [];
  private edges: VEdge[] = [];
  private byId = new Map<string, VNode>();
  private nbrs = new Map<string, Set<string>>();
  private cam = { x: 0, y: 0, k: 1 };
  private camAnim: { from: { x: number; y: number; k: number }; to: { x: number; y: number; k: number }; t0: number; dur: number } | null = null;
  private raf = 0;
  private dirty = true;
  private hover: VNode | null = null;
  private selectedId: string | null = null;
  private matches: Set<string> | null = null;
  private drag: { node: VNode | null; sx: number; sy: number; cx: number; cy: number; moved: boolean; pointerId: number } | null = null;
  private hasFitted = false;
  /** re-fit once the layout has cooled, unless the user took over the camera meanwhile */
  private autoFit = false;
  private destroyed = false;
  private ro: ResizeObserver;

  onOpen: (n: GNode) => void = () => {};
  onHover: (h: Hover) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDbl);
    canvas.addEventListener('keydown', this.onKey);
    // fonts load async; redraw labels once ready
    void document.fonts?.ready.then(() => this.invalidate());
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    c.removeEventListener('pointermove', this.onMove);
    c.removeEventListener('pointerup', this.onUp);
    c.removeEventListener('pointercancel', this.onUp);
    c.removeEventListener('pointerleave', this.onLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('dblclick', this.onDbl);
    c.removeEventListener('keydown', this.onKey);
  }

  /* ───────── data ───────── */

  setView(view: GraphView, opts: { refit?: boolean } = {}): void {
    const prevIds = new Set(this.byId.keys());
    const deg = new Map<string, number>();
    for (const e of view.edges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    // adjacency for placement + highlighting
    const nbrs = new Map<string, Set<string>>();
    for (const e of view.edges) {
      (nbrs.get(e.source) ?? nbrs.set(e.source, new Set()).get(e.source)!).add(e.target);
      (nbrs.get(e.target) ?? nbrs.set(e.target, new Set()).get(e.target)!).add(e.source);
    }
    const fresh: VNode[] = [];
    const nodes: VNode[] = view.nodes.map((g) => {
      let s = this.pos.get(g.id);
      const d = Math.max(g.degree || 0, deg.get(g.id) ?? 0);
      const r = g.kind === 'note' ? 2.6 + Math.min(9, Math.sqrt(d) * 1.35) : g.kind === 'tag' ? 3.2 : 2.6;
      if (!s) {
        s = { id: g.id, x: NaN, y: NaN, vx: 0, vy: 0, weight: 1, r };
        this.pos.set(g.id, s);
        fresh.push({ g, s });
      }
      s.r = r;
      s.weight = 1 + Math.min(4, Math.sqrt(d) * 0.35);
      return { g, s };
    });
    const byId = new Map(nodes.map((n) => [n.g.id, n]));
    // place new nodes: next to an already-positioned neighbour, else on a phyllotaxis spiral
    let spiral = 0;
    for (const n of fresh) {
      const anchor = [...(nbrs.get(n.g.id) ?? [])].map((id) => this.pos.get(id)).find((p) => p && Number.isFinite(p.x));
      if (anchor) {
        const a = Math.random() * Math.PI * 2;
        n.s.x = anchor.x + Math.cos(a) * 18;
        n.s.y = anchor.y + Math.sin(a) * 18;
      } else {
        const i = spiral++;
        const rad = 12 * Math.sqrt(0.5 + i);
        const ang = i * Math.PI * (3 - Math.sqrt(5));
        n.s.x = rad * Math.cos(ang);
        n.s.y = rad * Math.sin(ang);
      }
    }
    const edges: VEdge[] = [];
    for (const e of view.edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (a && b) edges.push({ a, b, kind: e.kind });
    }
    this.nodes = nodes;
    this.edges = edges;
    this.byId = byId;
    this.nbrs = nbrs;
    if (this.hover && !byId.has(this.hover.g.id)) this.setHover(null);
    this.sim.setData(
      nodes.map((n) => n.s),
      edges.map((e) => ({ source: e.a.s, target: e.b.s })),
    );

    const changed = fresh.length > 0 || nodes.length !== prevIds.size || nodes.some((n) => !prevIds.has(n.g.id));
    const first = !this.hasFitted;
    if (first || opts.refit) {
      this.sim.alpha = first ? 1 : Math.max(this.sim.alpha, 0.6);
      // warm-up synchronously so the first frame is already a sensible layout
      this.warmup(first ? 140 : 60, 70);
      this.fit(!first);
      this.hasFitted = nodes.length > 0;
      this.autoFit = true;
    } else if (changed) {
      this.sim.reheat(fresh.length > nodes.length * 0.3 ? 0.6 : 0.25);
    }
    if (reducedMotion()) this.warmup(400, 120);
    this.invalidate();
  }

  setSelected(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.invalidate();
  }

  /** highlight nodes matching a query (title/id substring; "#tag" matches tags). returns match ids */
  setSearch(q: string): string[] {
    const t = q.trim().toLowerCase();
    if (!t) {
      this.matches = null;
      this.invalidate();
      return [];
    }
    const out: string[] = [];
    const tag = t.startsWith('#') ? t.slice(1) : null;
    for (const n of this.nodes) {
      const g = n.g;
      const hit = tag
        ? (g.kind === 'tag' && g.id.toLowerCase().replace(/^#/, '').startsWith(tag)) || g.tags.some((x) => x.toLowerCase().startsWith(tag))
        : g.title.toLowerCase().includes(t) || g.id.toLowerCase().includes(t);
      if (hit) out.push(g.id);
    }
    this.matches = new Set(out);
    this.invalidate();
    return out;
  }

  private warmup(maxTicks: number, budgetMs: number): void {
    const t0 = performance.now();
    for (let i = 0; i < maxTicks && !this.sim.settled; i++) {
      this.sim.tick();
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  /* ───────── camera ───────── */

  fit(animate = true): void {
    if (!this.nodes.length) {
      this.setCam({ x: this.w / 2, y: this.h / 2, k: 1 }, animate);
      return;
    }
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.s.x - n.s.r);
      y0 = Math.min(y0, n.s.y - n.s.r);
      x1 = Math.max(x1, n.s.x + n.s.r);
      y1 = Math.max(y1, n.s.y + n.s.r);
    }
    const pad = 48;
    const k = clamp(Math.min((this.w - pad * 2) / Math.max(1, x1 - x0), (this.h - pad * 2) / Math.max(1, y1 - y0)), 0.12, 2.4);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    this.setCam({ x: this.w / 2 - cx * k, y: this.h / 2 - cy * k, k }, animate);
  }

  focus(id: string): void {
    const n = this.byId.get(id);
    if (!n) return;
    this.autoFit = false;
    const k = Math.max(this.cam.k, 1.5);
    this.setCam({ x: this.w / 2 - n.s.x * k, y: this.h / 2 - n.s.y * k, k }, true);
  }

  zoomBy(f: number, px = this.w / 2, py = this.h / 2): void {
    this.autoFit = false;
    const k = clamp(this.cam.k * f, 0.08, 8);
    const wx = (px - this.cam.x) / this.cam.k;
    const wy = (py - this.cam.y) / this.cam.k;
    this.camAnim = null;
    this.cam = { x: px - wx * k, y: py - wy * k, k };
    this.invalidate();
  }

  private setCam(to: { x: number; y: number; k: number }, animate: boolean): void {
    if (!animate || reducedMotion()) {
      this.camAnim = null;
      this.cam = to;
    } else this.camAnim = { from: { ...this.cam }, to, t0: performance.now(), dur: 380 };
    this.invalidate();
  }

  /* ───────── loop ───────── */

  invalidate(): void {
    this.dirty = true;
    if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (this.destroyed) return;
    let keep = false;
    if (!this.sim.settled) {
      this.sim.tick();
      this.dirty = true;
      keep = true;
      if (this.autoFit && this.sim.alpha < 0.05) {
        this.autoFit = false;
        this.fit(true);
      }
    }
    if (this.camAnim) {
      const a = this.camAnim;
      const t = Math.min(1, (performance.now() - a.t0) / a.dur);
      const e = 1 - Math.pow(1 - t, 3);
      this.cam = { x: a.from.x + (a.to.x - a.from.x) * e, y: a.from.y + (a.to.y - a.from.y) * e, k: a.from.k + (a.to.k - a.from.k) * e };
      if (t >= 1) this.camAnim = null;
      else keep = true;
      this.dirty = true;
    }
    if (this.dirty) this.draw();
    this.dirty = false;
    if (keep || this.drag?.node) this.raf = requestAnimationFrame(this.frame);
  };

  private resize(): void {
    const parent = this.canvas.parentElement;
    const rect = (parent ?? this.canvas).getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    // keep the world point at the viewport centre stable
    const ocx = (this.w / 2 - this.cam.x) / this.cam.k;
    const ocy = (this.h / 2 - this.cam.y) / this.cam.k;
    const wasInit = this.w > 1;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (wasInit) {
      this.cam.x = w / 2 - ocx * this.cam.k;
      this.cam.y = h / 2 - ocy * this.cam.k;
    } else {
      this.cam = { x: w / 2, y: h / 2, k: 1 };
    }
    if (!this.hasFitted && this.nodes.length) {
      this.fit(false);
      this.hasFitted = true;
    }
    this.invalidate();
  }

  /* ───────── drawing ───────── */

  private draw(): void {
    const { ctx, dpr, cam } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.nodes.length) return;

    const hover = this.hover;
    const focusSet: Set<string> | null = hover ? new Set([hover.g.id, ...(this.nbrs.get(hover.g.id) ?? [])]) : this.matches;
    const isFocus = (id: string) => !focusSet || focusSet.has(id);

    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.k, cam.k);
    const lw = 1 / cam.k;

    // view culling bounds in world coords
    const vx0 = -cam.x / cam.k - 20,
      vy0 = -cam.y / cam.k - 20,
      vx1 = (this.w - cam.x) / cam.k + 20,
      vy1 = (this.h - cam.y) / cam.k + 20;
    const inView = (s: SimNode) => s.x > vx0 && s.x < vx1 && s.y > vy0 && s.y < vy1;

    // edges — base layer
    ctx.lineWidth = lw;
    ctx.strokeStyle = C.edge;
    ctx.globalAlpha = focusSet ? 0.18 : 0.7;
    ctx.beginPath();
    const hiEdges: VEdge[] = [];
    for (const e of this.edges) {
      if (hover && (e.a === hover || e.b === hover)) {
        hiEdges.push(e);
        continue;
      }
      if (!inView(e.a.s) && !inView(e.b.s)) continue;
      ctx.moveTo(e.a.s.x, e.a.s.y);
      ctx.lineTo(e.b.s.x, e.b.s.y);
    }
    ctx.stroke();
    if (hiEdges.length) {
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = C.edgeHi;
      ctx.lineWidth = 1.2 * lw;
      ctx.beginPath();
      for (const e of hiEdges) {
        ctx.moveTo(e.a.s.x, e.a.s.y);
        ctx.lineTo(e.b.s.x, e.b.s.y);
      }
      ctx.stroke();
    }

    // nodes — batched by style
    const sel = this.selectedId;
    const matches = this.matches;
    const special = new Set<VNode>();
    for (const n of this.nodes) if (n === hover || n.g.id === sel || (n.g.kind === 'note' && matches?.has(n.g.id))) special.add(n);
    for (const pass of [false, true]) {
      // pass false: dimmed nodes, pass true: focused nodes
      ctx.globalAlpha = pass ? 1 : 0.22;
      // notes
      ctx.fillStyle = C.note;
      ctx.beginPath();
      for (const n of this.nodes) {
        if (n.g.kind !== 'note' || special.has(n) || isFocus(n.g.id) !== pass || !inView(n.s)) continue;
        ctx.moveTo(n.s.x + n.s.r, n.s.y);
        ctx.arc(n.s.x, n.s.y, n.s.r, 0, Math.PI * 2);
      }
      ctx.fill();
      // tags
      ctx.fillStyle = C.tag;
      ctx.beginPath();
      for (const n of this.nodes) {
        if (n.g.kind !== 'tag' || isFocus(n.g.id) !== pass || !inView(n.s)) continue;
        const r = n.s.r;
        ctx.rect(n.s.x - r, n.s.y - r, r * 2, r * 2);
      }
      ctx.fill();
      // ghosts
      ctx.strokeStyle = C.ghost;
      ctx.lineWidth = 1.2 * lw;
      ctx.beginPath();
      for (const n of this.nodes) {
        if (n.g.kind !== 'ghost' || isFocus(n.g.id) !== pass || !inView(n.s)) continue;
        ctx.moveTo(n.s.x + n.s.r, n.s.y);
        ctx.arc(n.s.x, n.s.y, n.s.r, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    // highlighted notes / tags (hover, selected, search hits)
    ctx.globalAlpha = 1;
    const ringFor = new Set<VNode>();
    if (hover) ringFor.add(hover);
    const selNode = sel ? this.byId.get(sel) : undefined;
    if (selNode) ringFor.add(selNode);
    for (const n of special) {
      const { x, y, r } = n.s;
      // a selected node outside the hover neighbourhood stays visible but quieter
      ctx.globalAlpha = isFocus(n.g.id) || ringFor.has(n) ? 1 : 0.5;
      ctx.fillStyle = C.noteHi;
      ctx.beginPath();
      if (n.g.kind === 'tag') ctx.rect(x - r, y - r, r * 2, r * 2);
      else ctx.arc(x, y, r, 0, Math.PI * 2);
      if (n.g.kind === 'ghost') {
        ctx.strokeStyle = C.noteHi;
        ctx.lineWidth = 1.2 * lw;
        ctx.stroke();
      } else ctx.fill();
      if (ringFor.has(n)) {
        ctx.strokeStyle = C.red;
        ctx.lineWidth = 1.5 * lw;
        ctx.beginPath();
        ctx.arc(x, y, r + 3 * lw + 1.2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    // labels (screen space, constant size)
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const k = cam.k;
    const showAll = k >= 1.5;
    const degThreshold = k >= 0.85 ? this.degreeQuantile(0.85) : k >= 0.45 ? this.degreeQuantile(0.97) : Infinity;
    const placed: [number, number, number, number][] = [];
    const drawLabel = (n: VNode, strong: boolean) => {
      const sx = n.s.x * k + cam.x;
      const sy = n.s.y * k + cam.y + n.s.r * k + 4;
      if (sx < -80 || sx > this.w + 80 || sy < -20 || sy > this.h + 20) return;
      const text = truncate(n.g.title, strong ? 48 : 28);
      const tw = ctx.measureText(text).width;
      const box: [number, number, number, number] = [sx - tw / 2 - 2, sy, sx + tw / 2 + 2, sy + 12];
      if (!strong && placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) return;
      placed.push(box);
      if (strong) {
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = C.bg;
        ctx.fillRect(box[0], box[1] - 1, box[2] - box[0], 13);
      }
      ctx.globalAlpha = strong ? 1 : focusSet && !focusSet.has(n.g.id) ? 0.25 : 0.85;
      ctx.fillStyle = strong ? C.labelHi : C.label;
      ctx.fillText(text, sx, sy);
    };
    // strong labels first so they win collisions
    const strong: VNode[] = [];
    if (hover) strong.push(hover);
    if (selNode && selNode !== hover) strong.push(selNode);
    for (const n of strong) drawLabel(n, true);
    const wanted: VNode[] = [];
    for (const n of this.nodes) {
      if (strong.includes(n)) continue;
      const focused = focusSet?.has(n.g.id) ?? false;
      const deg = this.nbrs.get(n.g.id)?.size ?? 0;
      if (focused && (hover || (this.matches && this.matches.size <= 40))) wanted.push(n);
      else if (showAll || deg >= degThreshold) wanted.push(n);
    }
    wanted.sort((a, b) => (this.nbrs.get(b.g.id)?.size ?? 0) - (this.nbrs.get(a.g.id)?.size ?? 0));
    for (const n of wanted.slice(0, 400)) drawLabel(n, false);
    ctx.globalAlpha = 1;
  }

  private degreeQuantile(q: number): number {
    const d = this.nodes.map((n) => this.nbrs.get(n.g.id)?.size ?? 0).sort((a, b) => a - b);
    return Math.max(2, d[Math.floor((d.length - 1) * q)] ?? 0);
  }

  /* ───────── interaction ───────── */

  private toWorld(px: number, py: number): [number, number] {
    return [(px - this.cam.x) / this.cam.k, (py - this.cam.y) / this.cam.k];
  }

  private local(e: PointerEvent | WheelEvent | MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private hit(px: number, py: number): VNode | null {
    const [wx, wy] = this.toWorld(px, py);
    const slack = 4 / this.cam.k;
    let best: VNode | null = null;
    let bestD = Infinity;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      const dx = n.s.x - wx;
      const dy = n.s.y - wy;
      const d = dx * dx + dy * dy;
      const rr = n.s.r + slack;
      if (d <= rr * rr && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private setHover(n: VNode | null): void {
    if (this.hover === n) return;
    this.hover = n;
    this.canvas.style.cursor = n ? 'pointer' : this.drag ? 'grabbing' : 'default';
    this.onHover(n ? { id: n.g.id, title: n.g.title, kind: n.g.kind, degree: this.nbrs.get(n.g.id)?.size ?? 0 } : null);
    this.invalidate();
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.canvas.focus({ preventScroll: true });
    const [px, py] = this.local(e);
    const node = this.hit(px, py);
    this.canvas.setPointerCapture(e.pointerId);
    this.camAnim = null;
    this.autoFit = false;
    this.drag = { node, sx: px, sy: py, cx: this.cam.x, cy: this.cam.y, moved: false, pointerId: e.pointerId };
    if (node) {
      node.s.fx = node.s.x;
      node.s.fy = node.s.y;
    } else this.canvas.style.cursor = 'grabbing';
  };

  private onMove = (e: PointerEvent): void => {
    const [px, py] = this.local(e);
    const d = this.drag;
    if (d && d.pointerId === e.pointerId) {
      if (!d.moved && Math.hypot(px - d.sx, py - d.sy) > 3) {
        d.moved = true;
        if (d.node) {
          this.sim.alphaTarget = 0.25;
          this.sim.reheat(0.25);
        }
      }
      if (!d.moved) return;
      if (d.node) {
        const [wx, wy] = this.toWorld(px, py);
        d.node.s.fx = wx;
        d.node.s.fy = wy;
        this.invalidate();
      } else {
        this.cam.x = d.cx + (px - d.sx);
        this.cam.y = d.cy + (py - d.sy);
        this.invalidate();
      }
      return;
    }
    this.setHover(this.hit(px, py));
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (d.node) {
      d.node.s.fx = null;
      d.node.s.fy = null;
      this.sim.alphaTarget = 0;
      if (!d.moved && e.type === 'pointerup') this.onOpen(d.node.g);
      this.invalidate();
    }
    this.canvas.style.cursor = this.hover ? 'pointer' : 'default';
  };

  private onLeave = (): void => {
    if (!this.drag) this.setHover(null);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [px, py] = this.local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    this.zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)), px, py);
  };

  private onDbl = (e: MouseEvent): void => {
    const [px, py] = this.local(e);
    if (!this.hit(px, py)) this.fit(true);
  };

  private onKey = (e: KeyboardEvent): void => {
    const step = 60;
    switch (e.key) {
      case '+':
      case '=':
        this.zoomBy(1.25);
        break;
      case '-':
      case '_':
        this.zoomBy(0.8);
        break;
      case '0':
        this.fit(true);
        break;
      case 'ArrowLeft':
        this.cam.x += step;
        break;
      case 'ArrowRight':
        this.cam.x -= step;
        break;
      case 'ArrowUp':
        this.cam.y += step;
        break;
      case 'ArrowDown':
        this.cam.y -= step;
        break;
      default:
        return;
    }
    e.preventDefault();
    this.invalidate();
  };
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ───────────────────────── Preact wrapper ───────────────────────── */

export interface GraphCanvasHandle {
  fit: () => void;
  focus: (id: string) => void;
}

export function GraphCanvas(props: {
  view: GraphView;
  selectedId?: string | null;
  search?: string;
  /** bump to force a re-fit (e.g. after toggling local mode) */
  fitKey?: string;
  onOpen?: (n: GNode) => void;
  onSearchMatches?: (ids: string[]) => void;
  handle?: (h: GraphCanvasHandle | null) => void;
  class?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useRef<GraphEngine | null>(null);
  const lastFitKey = useRef<string | undefined>(undefined);
  const [hover, setHover] = useState<Hover>(null);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const eng = new GraphEngine(ref.current!);
    engine.current = eng;
    eng.onOpen = (n) => cb.current.onOpen?.(n);
    eng.onHover = setHover;
    props.handle?.({ fit: () => eng.fit(true), focus: (id) => eng.focus(id) });
    return () => {
      props.handle?.(null);
      eng.destroy();
      engine.current = null;
    };
  }, []);

  useEffect(() => {
    const refit = lastFitKey.current !== undefined && lastFitKey.current !== props.fitKey;
    lastFitKey.current = props.fitKey;
    engine.current?.setView(props.view, { refit });
    // re-apply search highlighting to the new node set
    const ids = engine.current?.setSearch(props.search ?? '') ?? [];
    cb.current.onSearchMatches?.(ids);
  }, [props.view]);

  useEffect(() => {
    engine.current?.setSelected(props.selectedId ?? null);
  }, [props.selectedId]);

  useEffect(() => {
    const ids = engine.current?.setSearch(props.search ?? '') ?? [];
    cb.current.onSearchMatches?.(ids);
  }, [props.search]);

  return (
    <div class={`relative w-full h-full overflow-hidden ${props.class ?? ''}`}>
      <canvas
        ref={ref}
        tabIndex={0}
        aria-label="Memory graph. Drag to pan, scroll to zoom, plus and minus keys zoom, 0 fits, click a node to open it."
        class="absolute inset-0 outline-none touch-none select-none focus-visible:outline-1 focus-visible:outline-fg-3"
      />
      {/* zoom controls */}
      <div class="absolute right-3 bottom-3 flex flex-col border border-line bg-surface/90">
        <button class="p-1.5 text-fg-2 hover:text-fg hover:bg-subtle" title="Zoom in (+)" aria-label="Zoom in" onClick={() => engine.current?.zoomBy(1.3)}>
          <Plus size={13} />
        </button>
        <button class="p-1.5 text-fg-2 hover:text-fg hover:bg-subtle border-t border-line" title="Zoom out (−)" aria-label="Zoom out" onClick={() => engine.current?.zoomBy(1 / 1.3)}>
          <Minus size={13} />
        </button>
        <button class="p-1.5 text-fg-2 hover:text-fg hover:bg-subtle border-t border-line" title="Fit (0 / double-click)" aria-label="Fit graph" onClick={() => engine.current?.fit(true)}>
          <Scan size={13} />
        </button>
      </div>
      {/* hover read-out */}
      <div class="absolute left-3 bottom-3 font-mono text-[10px] tracking-[0.12em] uppercase text-fg-3 pointer-events-none flex items-center gap-2 max-w-[70%]">
        {hover ? (
          <>
            <span class="text-fg-2">{hover.kind}</span>
            <span class="text-fg truncate normal-case tracking-normal text-[11px]">{hover.title}</span>
            <span>· {hover.degree} links</span>
          </>
        ) : (
          <span>
            {props.view.nodes.length} nodes · {props.view.edges.length} edges
          </span>
        )}
      </div>
    </div>
  );
}
