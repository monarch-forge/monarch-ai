/**
 * Office: a night-shift pixel office (3/4 top-down, front-facing characters) with every agent in it.
 * Chat and Workshop rooms hold a desk per session; working agents sit at their desk typing, idle agents
 * wander the lounge, automations tend the server room, and agents idle for over an hour have gone home.
 * Click an agent or a desk to open the session. Drawn on a small canvas scaled up with nearest-neighbour.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SessionSummary } from '@monarch/shared';
import { approvals, useResource } from '../lib/store.ts';
import { EmptyState, Skeleton } from '../components/ui.tsx';
import { Building2 } from 'lucide-preact';

const T = 16; // tile size in canvas px
const WALL = 2; // wall height in tiles (top of each room)
const MAX_DESKS = 18; // per room; the most recently active
const DONE_MS = 5 * 60_000; // finished this recently: still at the desk
const IDLE_MS = 60 * 60_000; // idle longer than this: gone home
const SPEED = 26; // walking speed, px per second
const RED = '#d71921';

type Kind = 'chat' | 'builder' | 'sub' | 'bot';
type Area = 'chat' | 'work' | 'lounge' | 'server';
type Rect = { x: number; y: number; w: number; h: number };
type Desk = { s: SessionSummary; x: number; y: number; seat: { x: number; y: number }; area: Area };
type World = { w: number; h: number; rooms: Record<Area, Rect & { label: string }>; doors: Record<Area, { x: number; y: number }>; exit: { x: number; y: number }; desks: Desk[] };
type Walker = { x: number; y: number; area: Area; path: { x: number; y: number; area: Area }[]; dir: 'down' | 'up' | 'left' | 'right'; moving: boolean; wait: number };

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const kindOf = (s: SessionSummary): Kind => (s.kind === 'automation' ? 'bot' : s.parentSessionId ? 'sub' : s.kind === 'coding' ? 'builder' : 'chat');
const present = (s: SessionSummary) => s.running || Date.now() - Date.parse(s.updatedAt) < IDLE_MS;

/**
 * What an agent is doing, in priority order:
 *  needs  an approval is waiting on its session → stands at its desk with a red "!"
 *  work   a turn is running → seated, typing
 *  done   last turn ended under 5 min ago → seated, screen dimmed, a check mark
 *  break  5–60 min idle → wanders the lounge (a sub-agent whose parent works stays by the parent's desk)
 *  gone   idle over an hour → walks out of the lounge door; the desk goes dark
 */
type State = 'needs' | 'work' | 'done' | 'break' | 'gone';
function stateOf(s: SessionSummary, waiting: Set<string>): State {
  if (waiting.has(s.id)) return 'needs';
  if (s.running) return 'work';
  const age = Date.now() - Date.parse(s.updatedAt);
  return age < DONE_MS ? 'done' : age < IDLE_MS ? 'break' : 'gone';
}
const LABEL: Record<State, string> = { needs: 'Needs you', work: 'Working', done: 'Just finished', break: 'On a break', gone: 'Gone home' };

/** sub-agents sit right after their parent */
function ordered(all: SessionSummary[]): SessionSummary[] {
  const top = all.filter((s) => !s.parentSessionId || !all.some((p) => p.id === s.parentSessionId));
  return top.flatMap((p) => [p, ...all.filter((c) => c.parentSessionId === p.id)]).slice(0, MAX_DESKS);
}

function buildWorld(sessions: SessionSummary[], wt: number): World {
  const chat = ordered(sessions.filter((s) => s.kind === 'chat'));
  const work = ordered(sessions.filter((s) => s.kind === 'coding'));
  const autos = ordered(sessions.filter((s) => s.kind === 'automation'));
  const half = Math.floor(wt / 2);
  const perRow = (w: number) => Math.max(1, Math.floor((w - 2) / 3));
  const rows = Math.max(2, Math.ceil(chat.length / perRow(half)), Math.ceil(work.length / perRow(wt - half)));
  const topH = WALL + rows * 3 + 1;
  const serverW = Math.max(7, Math.min(Math.floor(wt / 3), 3 + autos.length * 3));
  const bottomH = 9;
  const rooms: World['rooms'] = {
    chat: { x: 0, y: 0, w: half, h: topH, label: 'CHAT' },
    work: { x: half, y: 0, w: wt - half, h: topH, label: 'WORKSHOP' },
    lounge: { x: 0, y: topH, w: wt - serverW, h: bottomH, label: 'LOUNGE' },
    server: { x: wt - serverW, y: topH, w: serverW, h: bottomH, label: 'SERVERS' },
  };
  const desks: Desk[] = [];
  const place = (list: SessionSummary[], area: Area) => {
    const r = rooms[area];
    const n = perRow(r.w);
    list.forEach((s, i) => {
      const tx = r.x + 1 + (i % n) * 3 + Math.floor((r.w - 2 - n * 3) / 2) + 1;
      const ty = r.y + WALL + Math.floor(i / n) * 3 + 0.5;
      desks.push({ s, x: tx * T, y: ty * T, seat: { x: tx * T + T, y: ty * T + T * 1.9 }, area });
    });
  };
  place(chat, 'chat');
  place(work, 'work');
  // automations: a terminal each along the server room floor
  autos.forEach((s, i) => {
    const r = rooms.server;
    const tx = r.x + 1 + (i % Math.max(1, Math.floor((r.w - 2) / 3))) * 3 + 0.5;
    const ty = r.y + WALL + 2.5 + Math.floor(i / Math.max(1, Math.floor((r.w - 2) / 3))) * 3;
    desks.push({ s, x: tx * T, y: ty * T, seat: { x: tx * T + T, y: ty * T + T * 1.9 }, area: 'server' });
  });
  const doors: World['doors'] = {
    chat: { x: (half / 2) * T, y: topH * T },
    work: { x: (half + (wt - half) / 2) * T, y: topH * T },
    server: { x: rooms.server.x * T, y: (topH + WALL + 3.5) * T },
    lounge: { x: (rooms.lounge.w / 2) * T, y: (topH + WALL + 3) * T },
  };
  // the way out: the lounge's left wall
  const exit = { x: -T, y: (topH + WALL + 3.5) * T };
  return { w: wt * T, h: (topH + bottomH) * T, rooms, doors, exit, desks };
}

/** route through doors: rooms only connect to the lounge */
function route(W: World, from: Area, to: { x: number; y: number }, toArea: Area): Walker['path'] {
  const p: Walker['path'] = [];
  if (from !== toArea) {
    if (from !== 'lounge') p.push({ ...W.doors[from], area: 'lounge' });
    if (toArea !== 'lounge') p.push({ ...W.doors[toArea], area: toArea });
  }
  p.push({ ...to, area: toArea });
  return p;
}

function loungeSpot(W: World, h: number): { x: number; y: number } {
  const r = W.rooms.lounge;
  const rnd = (n: number) => (Math.sin(h * 12.9898 + performance.now() * 0.001 + n) * 43758.5453) % 1;
  return { x: (r.x + 1.5 + Math.abs(rnd(1)) * (r.w - 3)) * T, y: (r.y + WALL + 1.2 + Math.abs(rnd(2)) * (r.h - WALL - 2)) * T };
}

/** where each agent wants to be, then advance every walker toward it; dt in seconds */
function step(W: World, walkers: Map<string, Walker>, waiting: Set<string>, dt: number) {
  const byId = new Map(W.desks.map((d) => [d.s.id, d]));
  for (const d of W.desks) {
    const s = d.s;
    const st = stateOf(s, waiting);
    const h = hash(s.id);
    let a = walkers.get(s.id);
    if (st === 'gone' && !a) continue;
    const parent = s.parentSessionId ? byId.get(s.parentSessionId) : undefined;
    const nearParent = st === 'break' && parent && stateOf(parent.s, waiting) === 'work';
    const atDesk = st !== 'break' && st !== 'gone';
    if (!a) {
      // first sight: already where the state says (no parade on page open)
      const at = atDesk || d.area === 'server' ? d.seat : loungeSpot(W, h);
      a = { x: at.x, y: at.y, area: atDesk || d.area === 'server' ? d.area : 'lounge', path: [], dir: 'up', moving: false, wait: 1 + (h % 3) };
      walkers.set(s.id, a);
    }
    const last = a.path[a.path.length - 1];
    const goTo = (to: { x: number; y: number }, area: Area) => {
      if ((!last || last.x !== to.x || last.y !== to.y) && (a!.x !== to.x || a!.y !== to.y)) a!.path = route(W, a!.area, to, area);
    };
    if (st === 'gone') {
      goTo(W.exit, 'lounge');
      if (!a.path.length) {
        walkers.delete(s.id);
        continue;
      }
    } else if (atDesk || d.area === 'server') goTo(d.seat, d.area);
    else if (nearParent) goTo({ x: parent!.seat.x + 20, y: parent!.seat.y - 2 }, parent!.area);
    else if (!a.path.length || (last && last.area !== 'lounge')) {
      a.wait -= dt;
      if (a.wait <= 0 || (last && last.area !== 'lounge')) {
        a.path = route(W, a.area, loungeSpot(W, h), 'lounge');
        a.wait = 2 + ((h + Math.floor(performance.now() / 1000)) % 5);
      }
    }
    const next = a.path[0];
    a.moving = !!next;
    if (!next) {
      if (atDesk) a.dir = st === 'needs' ? 'down' : 'up'; // seated facing the desk; standing to call you
      continue;
    }
    const dx = next.x - a.x;
    const dy = next.y - a.y;
    const dist = Math.hypot(dx, dy);
    const mv = SPEED * dt;
    if (dist <= mv) {
      a.x = next.x;
      a.y = next.y;
      a.area = next.area;
      a.path.shift();
    } else {
      a.x += (dx / dist) * mv;
      a.y += (dy / dist) * mv;
    }
    a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  }
  for (const id of walkers.keys()) if (!byId.has(id)) walkers.delete(id);
}

type Px = (x: number, y: number, w: number, h: number, c: string) => void;

/** a 12x18 character, anchored at its feet (x centre, y bottom) */
function character(R: Px, k: Kind, a: Walker, t: number, h: number, seated: boolean, typing: boolean) {
  const x = Math.round(a.x - 6);
  const y = Math.round(a.y - 18);
  const f = a.moving ? Math.floor(t / 160) % 2 : 0;
  const type = typing ? Math.floor(t / 110 + h) % 2 : 0;
  const dir = seated ? 'up' : a.dir;
  R(x + 1, y + 17, 10, 2, 'rgba(0,0,0,0.45)'); // shadow
  if (k === 'bot') {
    // round robot hovering over the floor, a red eye sweeping
    const bob = Math.round(Math.sin(t / 300 + h));
    R(x + 2, y + 6 + bob, 8, 9, '#25262b');
    R(x + 1, y + 8 + bob, 10, 5, '#25262b');
    R(x + 3, y + 5 + bob, 6, 1, '#3a3c42');
    if (dir !== 'up') R(x + 3 + (Math.floor(t / 250 + h) % 5), y + 9 + bob, 2, 2, RED);
    R(x + 5, y + 3 + bob, 2, 2, '#3a3c42');
    return;
  }
  const P = {
    chat: { top: RED, top2: '#8e1117', face: '#e8c4a8', body: '#b0151c', body2: '#6e0d12', legs: '#2a0a0c', belt: '' },
    builder: { top: '#e6e6e8', top2: '#a6a8ae', face: '#d9a77c', body: '#2f333a', body2: '#22252b', legs: '#16181c', belt: RED },
    sub: { top: '#8a8d95', top2: '#5b5e66', face: '#0a0a0b', body: '#4a4d55', body2: '#33363c', legs: '#25272c', belt: '' },
  }[k];
  const small = k === 'sub' ? 2 : 0; // the droid is a little shorter
  const hy = y + small;
  // legs (hidden when seated)
  if (!seated) {
    const l = dir === 'left' || dir === 'right' ? [f ? 1 : -1, f ? -1 : 1] : [f, 1 - f];
    R(x + 3, hy + 13, 2, 4 - l[0], P.legs);
    R(x + 7, hy + 13, 2, 4 - l[1], P.legs);
  }
  // body
  R(x + 2, hy + 8, 8, 6, P.body);
  R(x + 2, hy + 12, 8, 2, P.body2);
  if (P.belt) R(x + 2, hy + 11, 8, 1, P.belt);
  // arms
  const sw = a.moving ? (f ? 1 : -1) : 0;
  if (dir === 'left' || dir === 'right') R(x + 5 + sw, hy + 9, 2, 4, P.body2);
  else {
    R(x + 1, hy + 9 + (seated ? -type : sw), 1, 4, P.body2);
    R(x + 10, hy + 9 + (seated ? type - 1 : -sw), 1, 4, P.body2);
  }
  // head
  if (k === 'chat') {
    // Monarch: red hood with a face peeking out, wing tips on the shoulders
    R(x + 2, hy + 1, 8, 8, P.top);
    R(x + 3, hy, 6, 1, P.top);
    R(x + 0, hy + 8, 2, 3, P.top2);
    R(x + 10, hy + 8, 2, 3, P.top2);
    if (dir === 'down') {
      R(x + 4, hy + 3, 4, 5, P.face);
      R(x + 4, hy + 5, 1, 1, '#1a0204');
      R(x + 7, hy + 5, 1, 1, '#1a0204');
    } else if (dir === 'left' || dir === 'right') {
      R(x + (dir === 'left' ? 2 : 6), hy + 3, 4, 5, P.face);
      R(x + (dir === 'left' ? 3 : 8), hy + 5, 1, 1, '#1a0204');
    } else R(x + 3, hy + 2, 6, 6, P.top2);
  } else if (k === 'builder') {
    R(x + 3, hy + 3, 6, 5, P.face);
    R(x + 2, hy + 1, 8, 3, P.top); // hard hat
    R(x + 1, hy + 3, 10, 1, P.top2); // brim
    R(x + 5, hy + 1, 2, 2, P.top2);
    if (dir === 'down') {
      R(x + 4, hy + 5, 1, 1, '#1a1a1a');
      R(x + 7, hy + 5, 1, 1, '#1a1a1a');
    } else if (dir === 'left' || dir === 'right') R(x + (dir === 'left' ? 3 : 8), hy + 5, 1, 1, '#1a1a1a');
    else R(x + 3, hy + 4, 6, 4, '#3b2a1f'); // hair at the back
  } else {
    // droid: boxy head, visor with a red eye, blinking antenna
    R(x + 2, hy + 1, 8, 7, P.top);
    R(x + 2, hy + 6, 8, 1, P.top2);
    if (dir === 'down') {
      R(x + 3, hy + 3, 6, 2, P.face);
      R(x + 5, hy + 3, 2, 2, RED);
    } else if (dir === 'left' || dir === 'right') R(x + (dir === 'left' ? 2 : 6), hy + 3, 4, 2, P.face);
    R(x + 5, hy - 2, 1, 3, P.top2);
    R(x + 5, hy - 3, 2, 1, Math.floor(t / 600 + h) % 2 ? RED : '#4a0a0d');
  }
}

function draw(ctx: CanvasRenderingContext2D, W: World, walkers: Map<string, Walker>, waiting: Set<string>, t: number, hover: string | null) {
  const R: Px = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  };
  const glow = (x: number, y: number, r: number, rgb: string, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';
  R(0, 0, W.w, W.h, '#050506');

  // rooms: floor, back wall with a 3/4 face, side walls
  const floors: Record<Area, [string, string]> = { chat: ['#141114', '#171316'], work: ['#111316', '#13161a'], lounge: ['#121212', '#151515'], server: ['#0d0e11', '#101216'] };
  for (const area of Object.keys(W.rooms) as Area[]) {
    const r = W.rooms[area];
    const [a, b] = floors[area];
    for (let ty = r.y + WALL; ty < r.y + r.h; ty++) for (let tx = r.x; tx < r.x + r.w; tx++) R(tx * T, ty * T, T, T, (tx + ty) % 2 ? a : b);
    R(r.x * T, r.y * T, r.w * T, WALL * T, '#18181c'); // wall face
    R(r.x * T, r.y * T, r.w * T, 3, '#26262b'); // wall top
    R(r.x * T, (r.y + WALL) * T - 2, r.w * T, 2, '#0b0b0d'); // skirting
    R(r.x * T, r.y * T, 2, r.h * T, '#0b0b0d');
    ctx.fillStyle = '#8a8a90';
    ctx.fillText(r.label, r.x * T + 6, r.y * T + 8);
  }
  // night windows on the office walls, with a moon in one
  for (const area of ['chat', 'work'] as Area[]) {
    const r = W.rooms[area];
    for (let wx = r.x * T + 72; wx < (r.x + r.w) * T - 28; wx += 56) {
      R(wx, r.y * T + 6, 22, 16, '#0b0f1c');
      R(wx, r.y * T + 13, 22, 1, '#18181c');
      R(wx + 10, r.y * T + 6, 1, 16, '#18181c');
      if ((wx / 56) % 3 < 1) R(wx + 3, r.y * T + 8, 1, 1, '#c8ccd8');
      if (area === 'chat' && wx === r.x * T + 72) R(wx + 14, r.y * T + 8, 4, 4, '#e8e4d0');
    }
  }
  // doorways: gaps in the walls between rooms and the lounge
  for (const area of ['chat', 'work'] as Area[]) {
    const d = W.doors[area];
    R(d.x - T, d.y - 2, T * 2, WALL * T + 2, '#141414');
  }
  R(W.rooms.server.x * T - 2, W.doors.server.y - T, 4, T * 2, '#121212');

  // lounge: rug, couch, coffee machine, plant, a warm lamp
  const L = W.rooms.lounge;
  const lx = L.x * T;
  const ly = (L.y + WALL) * T;
  R(lx + 3 * T, ly + 2 * T, 6 * T, 3 * T, '#1d1012');
  R(lx + 3 * T + 2, ly + 2 * T + 2, 6 * T - 4, 3 * T - 4, '#24141a');
  R(lx + 3.5 * T, ly + 0.3 * T, 5 * T, T, '#4a0f14'); // couch back
  R(lx + 3.5 * T, ly + 1.1 * T, 5 * T, 0.6 * T, '#6e141b');
  R(lx + L.w * T - 3 * T, L.y * T + 10, 12, 20, '#2a2a30'); // coffee machine on the wall
  R(lx + L.w * T - 3 * T + 3, L.y * T + 14, 6, 3, Math.floor(t / 1500) % 2 ? RED : '#4a0a0d');
  R(lx + T, ly + 0.2 * T, 10, 10, '#1f3a22'); // plant
  R(lx + T + 2, ly + 0.2 * T + 10, 6, 6, '#3a2a1e');
  glow(lx + 6 * T, ly + 2.5 * T, 70, '230,180,120', 0.07);

  // server room: a few racks, one slow LED each
  const S = W.rooms.server;
  for (let i = 0, rx = S.x * T + 60; rx < (S.x + S.w) * T - 18; rx += 22, i++) {
    R(rx, S.y * T + 6, 16, WALL * T + 6, '#1a1b20');
    R(rx + 2, S.y * T + 9, 12, WALL * T, '#121317');
    R(rx + 4, S.y * T + 12, 2, 1, Math.floor(t / (1800 + i * 400)) % 2 ? '#7f95b8' : '#2a2f3a');
  }
  glow((S.x + S.w / 2) * T, (S.y + WALL) * T, S.w * 8, '110,130,170', 0.06);

  // desks + whoever is at them, drawn back to front
  const sprites: { y: number; draw: () => void }[] = [];
  for (const d of W.desks) {
    const s = d.s;
    const h = hash(s.id);
    const st = stateOf(s, waiting);
    const atServer = d.area === 'server';
    sprites.push({
      y: d.y + T,
      draw: () => {
        if (st === 'needs') glow(d.x + T, d.y + T, 36, '215,25,33', 0.22 + 0.08 * Math.sin(t / 250));
        else if (s.running) glow(d.x + T, d.y + T * 0.6, 34, atServer ? '110,130,170' : d.area === 'chat' ? '215,25,33' : '150,170,210', 0.14);
        if (hover === s.id) {
          ctx.strokeStyle = '#e8e8ea';
          ctx.lineWidth = 1;
          ctx.strokeRect(d.x - 3.5, d.y - 6.5, T * 2 + 7, T * 2 + 10);
        }
        if (atServer) {
          // terminal pedestal
          R(d.x + 8, d.y + 2, 16, 12, '#1d1e23');
          R(d.x + 10, d.y + 4, 12, 7, s.running ? '#c8d2e6' : '#22252c');
          R(d.x + 14, d.y + 14, 4, 4, '#16171b');
          return;
        }
        // desk top and front, monitor facing the seat, lamp, mug
        R(d.x, d.y + 4, T * 2, 9, '#2a2124');
        R(d.x, d.y + 13, T * 2, 5, '#1b1517');
        R(d.x + 9, d.y - 4, 14, 9, '#0e0e10');
        R(d.x + 10, d.y - 3, 12, 6, s.running ? (Math.floor(t / 700 + h) % 4 ? '#e9ebf0' : '#c3c8d2') : st === 'needs' ? RED : st === 'done' ? '#6b7180' : st === 'break' ? '#20232a' : '#111113');
        R(d.x + 15, d.y + 5, 2, 2, '#0e0e10');
        R(d.x + 3, d.y + 1, 3, 4, st !== 'gone' ? '#e6d4a6' : '#2a2a2f');
        R(d.x + 26, d.y + 6, 3, 3, h % 2 ? '#8e1117' : '#d9dade');
        // chair
        R(d.seat.x - 5, d.seat.y - 9, 10, 4, '#202024');
      },
    });
  }
  for (const [id, a] of walkers) {
    const d = W.desks.find((x) => x.s.id === id);
    if (!d) continue;
    const st = stateOf(d.s, waiting);
    const atSeat = !a.moving && Math.abs(a.x - d.seat.x) < 1 && Math.abs(a.y - d.seat.y) < 1;
    const seated = atSeat && (st === 'work' || st === 'done') && d.area !== 'server';
    sprites.push({
      y: a.y + (seated ? 1 : 0),
      draw: () => {
        character(R, kindOf(d.s), a, t, hash(id), seated, seated && st === 'work');
        if (hover === id && !seated) {
          ctx.strokeStyle = '#e8e8ea';
          ctx.strokeRect(Math.round(a.x - 8) + 0.5, Math.round(a.y - 22) + 0.5, 16, 24);
        }
        if (atSeat && st === 'needs') {
          // waiting on you: a bouncing red "!"
          const by = Math.round(a.y - 30 + Math.sin(t / 180) * 1.5);
          R(a.x - 1, by, 3, 6, RED);
          R(a.x - 1, by + 8, 3, 2, RED);
        } else if (atSeat && st === 'done') {
          // finished: a small check mark
          const cx = Math.round(a.x + 6);
          const cy = Math.round(a.y - 24);
          R(cx, cy + 2, 1, 1, '#e8e8ea');
          R(cx + 1, cy + 3, 1, 1, '#e8e8ea');
          R(cx + 2, cy + 2, 1, 1, '#e8e8ea');
          R(cx + 3, cy + 1, 1, 1, '#e8e8ea');
          R(cx + 4, cy, 1, 1, '#e8e8ea');
        } else if (st === 'break' && !a.moving && Math.floor(t / 1200 + hash(id)) % 4 === 0) {
          ctx.fillStyle = '#6e6e74';
          ctx.fillText('…', a.x + 4, a.y - 26);
        }
      },
    });
  }
  sprites.sort((p, q) => p.y - q.y).forEach((s) => s.draw());
}

export default function OfficePage() {
  const sessions = useResource<SessionSummary[]>('/sessions', ['sessions'], { intervalMs: 15_000 });
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const walkers = useRef(new Map<string, Walker>());
  const [tiles, setTiles] = useState(32);
  const [scale, setScale] = useState(2);
  const [hover, setHover] = useState<{ s: SessionSummary; x: number; y: number } | null>(null);

  // fit the floor width (in tiles) and an integer scale to the available width
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth;
      const sc = w >= 1100 ? 3 : 2;
      setScale(sc);
      setTiles(Math.max(22, Math.min(44, Math.floor(w / sc / T))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = useMemo(() => {
    const list = [...(sessions.data ?? [])].sort((a, b) => Number(b.running) - Number(a.running) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return buildWorld(list, tiles);
  }, [sessions.data, tiles]);

  // a new layout moves desks: let everyone walk from where they are
  useEffect(() => {
    for (const a of walkers.current.values()) a.path = [];
  }, [W]);

  const waiting = useMemo(() => new Set(approvals.value.map((x) => x.sessionId)), [approvals.value]);
  const hoverId = hover?.s.id ?? null;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      // ~15 fps is plenty for pixel motion and keeps the CPU quiet
      if (t - last > 66) {
        const dt = Math.min(0.2, (t - (last || t)) / 1000);
        last = t;
        step(W, walkers.current, waiting, dt);
        draw(ctx, W, walkers.current, waiting, t, hoverId);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [W, hoverId, waiting]);

  const hitAt = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W.w;
    const py = ((e.clientY - r.top) / r.height) * W.h;
    // agents first (they walk in front of desks), then desks
    for (const [id, a] of walkers.current) {
      if (px >= a.x - 8 && px <= a.x + 8 && py >= a.y - 22 && py <= a.y + 2) {
        const d = W.desks.find((x) => x.s.id === id);
        if (d) return { s: d.s, x: e.clientX - r.left, y: e.clientY - r.top };
      }
    }
    const d = W.desks.find((d) => px >= d.x - 2 && px < d.x + T * 2 + 2 && py >= d.y - 6 && py < d.y + T * 2);
    return d ? { s: d.s, x: e.clientX - r.left, y: e.clientY - r.top } : null;
  };
  const open = (s: SessionSummary) => {
    location.hash = `#/${s.kind === 'coding' ? 'workshop' : 'chat'}/${encodeURIComponent(s.id)}`;
  };

  const all = sessions.data ?? [];
  const running = all.filter((s) => s.running).length;
  const around = all.filter(present).length;
  const needs = all.filter((s) => waiting.has(s.id)).length;

  return (
    <div class="h-full overflow-y-auto px-4 md:px-8 py-6">
      <div class="max-w-[1400px] mx-auto flex flex-col gap-4">
        <div class="flex items-baseline gap-3">
          <h1 class="hud-title">Office</h1>
          <span class="text-[12px] text-fg-3">
            {needs ? `${needs} need you · ` : ''}{running ? `${running} at work` : 'Nobody is working'} · {around} in the office · {all.length} desks
          </span>
        </div>
        <div ref={wrap} class="relative">
          {sessions.loading && !sessions.data ? (
            <Skeleton lines={6} />
          ) : !all.length ? (
            <EmptyState icon={<Building2 size={18} strokeWidth={1.5} />} title="The office is empty" hint="Start a chat or a Workshop session and an agent takes a desk." />
          ) : (
            <>
              <canvas
                ref={canvas}
                width={W.w}
                height={W.h}
                style={{ width: `${W.w * scale}px`, height: `${W.h * scale}px`, imageRendering: 'pixelated' }}
                class="block mx-auto rounded-[4px] border border-line cursor-pointer"
                onMouseMove={(e) => setHover(hitAt(e))}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => {
                  const d = hitAt(e);
                  if (d) open(d.s);
                }}
                aria-label="Office: agents at work and wandering the floor"
              />
              {hover && (
                <div
                  class="pointer-events-none absolute z-10 rounded-[6px] bg-[var(--bg-raised)] border border-line px-2.5 py-1.5 text-[12px] text-fg max-w-[280px] shadow-lg"
                  style={{ left: `calc(50% - ${(W.w * scale) / 2}px + ${hover.x + 12}px)`, top: `${hover.y + 12}px` }}
                >
                  <div class="truncate">{hover.s.title || 'Untitled'}</div>
                  <div class="text-[11px] text-fg-3">
                    {LABEL[stateOf(hover.s, waiting)]} · {hover.s.parentSessionId ? 'sub-agent' : hover.s.kind === 'coding' ? 'Workshop' : hover.s.kind} · {hover.s.model}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div class="flex flex-wrap gap-x-5 gap-y-1 text-[11.5px] text-fg-3">
          <span>Red hood = Chat</span>
          <span>Hard hat = Workshop</span>
          <span>Droid = sub-agent</span>
          <span>Round bot = automation</span>
          <span>Red ! = needs you · typing = working · check = finished under 5 min · lounge = on a break (5–60 min) · gone home after an hour · click anyone to open their session</span>
        </div>
      </div>
    </div>
  );
}
