# Monarch AI — architecture & build brief

Monarch is a Jarvis-style personal "agentic OS": a calm HUD dashboard + an AI agent that can chat, code,
handle multiple Gmail accounts, Slack, an Obsidian-like memory vault (graph view), calendar/tasks, automations,
system monitoring, web research — with approval gates for risky actions.

```
monarch-arise/
  packages/shared/src/protocol.ts   ← THE contract: all types, WS frames, REST surface (read it first)
  apps/core/   Node 26 + TypeScript backend on http://127.0.0.1:7717 (Hono + ws). Run: npm run dev (tsx watch)
    src/kernel.ts         paths, JsonStore, secrets, bus.broadcast, activity(), notify(), ToolDef/defineTool   [orchestrator-owned]
    src/settings.ts       getSettings / updateSettings / onSettingsChanged                                     [orchestrator-owned]
    src/tools/index.ts    tool registry (imports tools/*.ts)                                                   [orchestrator-owned]
    src/routes/index.ts   route registry (imports routes/*.ts)                                                 [orchestrator-owned]
    src/index.ts, src/server.ts                         Core-A
    src/services/*                                       Core-A  (usage.ts contract stub exists)
    src/routes/system.ts, routes/productivity.ts        Core-A
    src/tools/system.ts, tools/productivity.ts, tools/web.ts   Core-A
    src/agent/*                                          Core-B  (orchestrator.ts contract stub exists)
    src/routes/agent.ts, tools/coding.ts                 Core-B
    src/integrations/{google,slack,memory}/*             Core-C  (google/index.ts + memory/index.ts contract stubs exist)
    src/routes/integrations.ts, tools/mail.ts, tools/slack.ts, tools/memory.ts   Core-C
  apps/ui/     Vite 8 + Preact 10 + Tailwind 4 + daisyUI 5 (custom "monarch" theme)
    src/index.css, src/app.tsx, src/main.tsx, src/lib/api.ts, src/lib/store.ts, src/components/ui.tsx  [orchestrator-owned]
    pages/overview.tsx, pages/systems.tsx, components/command-palette.tsx, components/notifications.tsx, lib/voice.ts   UI-A
    pages/comms.tsx, pages/workshop.tsx, pages/config.tsx, components/approvals.tsx, components/chat/*, lib/markdown.ts UI-B
    pages/mail.tsx, pages/slack.tsx, pages/agenda.tsx, pages/memory.tsx, components/graph/*                            UI-C
  src-tauri/   Tauri v2 shell that spawns the core (node) and hosts the UI                                    Tauri
  docs/research/  verified API notes: pi.md, claude-agent-sdk.md, tauri-daisyui.md
```

## Rules for every builder
- Only create/edit files you own (above). You may ADD new files inside your own folders. If you need a change in an
  orchestrator-owned or another builder's file, do NOT edit it — note it in your final report.
- Cross-module calls go only through the contract stubs (`agent/orchestrator.ts`, `services/usage.ts`,
  `integrations/google/index.ts`, `integrations/memory/index.ts`); keep their exported signatures exactly.
- All REST/WS shapes come from `@monarch/shared` — never invent parallel types for wire data.
- TypeScript strict; imports use explicit `.ts`/`.tsx` extensions (`allowImportingTsExtensions`). ESM only.
- Core: never block the event loop; never send secrets to the UI; errors in route handlers → `{ error }` JSON with status.
- Data lives under `~/.monarch-ai` (`paths` in kernel.ts). Use `dataStore()` / `secrets` from kernel.ts.
- Emit `changed('<collection>')` after mutations so the UI refetches; use `activity(tag, text)` for the dashboard log.
- Typecheck your side: `cd apps/core && npx tsc -p tsconfig.json` / `cd apps/ui && npx tsc -p tsconfig.json`.
  Errors that come only from another builder's still-stubbed module are expected; your own files must be clean.
- No new heavy deps without need. If you add one, run `npm install <pkg> --workspace @monarch/core|ui` from repo root.

## Design language (UI)
Reference: a JARVIS-like HUD but **less flashy**. Palette (exact): bg #121213, surface #1C1C1E, subtle #262629,
border #323236, text #F4F4F6 / #9E9EA4 / #5E5E64, accent red #D71921 (hover #B8141B).
Tailwind tokens: `bg-surface bg-subtle border-line text-fg text-fg-2 text-fg-3 bg-red text-red`; fonts Geist / Geist Mono.
- Panels: `<Panel code="ENV.01" title="Local conditions" right={<Tag>clear</Tag>}>` from components/ui.tsx.
- Mono uppercase micro-labels (`hud-label`), tabular numbers (`hud-value`), segmented meters (`<SegBar/>`), outline tags (`<Tag/>`).
- Red is only for: active nav, live/attention states, the agent core when working, primary buttons, flags. No glow, no gradients, no neon.
- Motion: minimal; slow rotation only while the agent is working; respect reduced-motion.
- Use daisyUI components (btn, input, select, textarea, toggle, modal, tabs, dropdown, tooltip, loading, kbd, table)
  restyled through the theme; prefer the primitives in components/ui.tsx for HUD chrome.
- Dense but legible: 12–14px body, generous 1px dividers, everything aligned to a grid.
