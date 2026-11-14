---
name: Weekly review
description: Close out the week and plan the next one — tasks, calendar, inbox, notes. Use when the user asks for a weekly review or "plan my week".
origin: user
uses: 0
updatedAt: 2026-11-14T00:00:00.000Z
---

# Weekly review

Goal: a short, honest picture of the past week and a concrete plan for the next one. Keep the final answer under ~25 lines.

## 1. Look back (past 7 days)
1. `tasks_list` with `status: "done"` — what got finished. Group by tag.
2. `tasks_list` with `status: "open"` — flag anything overdue (`due` in the past) or stale (created > 14 days ago).
3. `calendar_list` for the past 7 days — note the meetings that ate the most time.

## 2. Look ahead (next 7 days)
1. `calendar_list` for the next 7 days — find conflicts, back-to-back blocks, and free focus windows (≥ 2h).
2. `mail_search` for `is:unread newer_than:7d` (and `is:starred`) — list threads that still need a reply, max 5.

## 3. Propose, then act only with consent
- Suggest at most 3 priorities for the week, each tied to a task or event.
- Offer to: reschedule overdue tasks (`task_update`), add missing tasks (`task_add`), block focus time (`calendar_add`).
  Ask before changing anything.

## 4. Remember
- Save a short summary with `memory_write` titled `Weekly review YYYY-MM-DD` (tags: `review`), linking people/projects as [[wikilinks]].

If a source is unavailable (no Google account, no mail), say so in one line and continue with the rest.
