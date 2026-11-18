/** brief_save (deferred): stores the structured morning brief shown on Home. */
import { z } from 'zod';
import { defineTool, type ToolDef } from '../kernel.ts';
import { saveBrief } from '../services/background.ts';

const item = z.union([z.string(), z.object({ title: z.string(), detail: z.string().optional(), href: z.string().optional() })]);
const list = (d: string) => z.array(item).max(20).optional().describe(d);

const briefSave = defineTool({
  name: 'brief_save',
  group: 'background',
  keywords: ['brief', 'morning', 'briefing', 'summary', 'today'],
  description: 'Save the morning brief shown at the top of Overview. Items are short titles with optional detail. "What I handled" is filled automatically.',
  risk: 'safe',
  schema: z.object({
    needsYou: list('Things needing the user today (replies, approvals, deadlines).'),
    today: list('Calendar events today, e.g. "09:30 Standup".'),
    messages: z
      .object({ mail: z.number().optional(), slack: z.number().optional(), whatsapp: z.number().optional(), top: list('Up to 5 notable messages.') })
      .optional()
      .describe('Unread counts per source (omit unconnected sources) + top items.'),
    prs: list('Open PRs needing review/attention.'),
    money: list('Cards due soon, budget alerts.'),
  }),
  summarize: () => 'Save morning brief',
  run: (i) => {
    const b = saveBrief(i as Parameters<typeof saveBrief>[0]);
    return `Brief saved (${b.needsYou.length} needs-you, ${b.today.length} events).`;
  },
});

export const tools: ToolDef[] = [briefSave];
