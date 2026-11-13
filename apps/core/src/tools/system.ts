/** System tools: time, weather, machine status, processes, notifications. */
import { z } from 'zod';
import { defineTool, notify, type ToolDef } from '../kernel.ts';
import { getSettings } from '../settings.ts';
import { localIso } from '../services/dates.ts';
import { describeWeather, geocode, getWeather } from '../services/weather.ts';
import { fmtBytes, getMetrics, systemInfo, topProcesses } from '../services/metrics.ts';

const getDatetime = defineTool({
  name: 'get_datetime',
  description:
    "Get the current local date and time, weekday, IANA timezone and UTC offset of the user's machine. Use before computing relative dates (\"tomorrow at 9\", \"next Friday\") for tasks, reminders and calendar events.",
  risk: 'safe',
  tag: 'SYS',
  schema: z.object({}),
  run: () => {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const human = now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    return [`Local time: ${human}`, `ISO: ${localIso(now)}`, `Timezone: ${tz}`, `Unix: ${Math.floor(now.getTime() / 1000)}`].join('\n');
  },
});

const getWeatherTool = defineTool({
  name: 'get_weather',
  description:
    "Current weather, next hours and a 5-day forecast (Open-Meteo). Without `location` it uses the user's saved home location; pass a place name (\"Tokyo\", \"Berlin, DE\") to look up somewhere else.",
  risk: 'safe',
  tag: 'NET',
  schema: z.object({
    location: z.string().optional().describe('Optional place name to geocode, e.g. "Paris" or "Austin, Texas". Omit for the saved home location.'),
  }),
  summarize: (i) => `Weather${i.location ? ` for ${i.location}` : ''}`,
  run: async ({ location }) => {
    const s = getSettings();
    let loc = s.user.location;
    if (location?.trim()) {
      const hits = await geocode(location, 1);
      if (!hits.length) return `No place found matching "${location}".`;
      loc = hits[0];
    }
    if (!loc) return 'No home location is set. Ask the user for their city (it can be saved in Config), or pass `location`.';
    return describeWeather(await getWeather(loc), s.user.units);
  },
});

const systemStatus = defineTool({
  name: 'system_status',
  description:
    "Snapshot of the user's computer: CPU load and temperature, memory, swap, disk usage per volume, network throughput, battery, uptime and load average, plus host/OS info.",
  risk: 'safe',
  tag: 'SYS',
  schema: z.object({}),
  run: async () => {
    const [m, info] = await Promise.all([getMetrics(), systemInfo()]);
    const up = m.uptimeSec;
    const uptime = `${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
    const lines = [
      `Host ${info.hostname} — ${info.platform} ${info.release} (${info.arch}), ${info.cpuModel}, ${info.cpuCores} cores`,
      `CPU: ${m.cpu.load}% load${m.cpu.tempC ? `, ${m.cpu.tempC}°C` : ''}; load avg ${m.loadAvg.join(' / ')}`,
      `Memory: ${fmtBytes(m.mem.usedBytes)} / ${fmtBytes(m.mem.totalBytes)} (${m.mem.percent}%)`,
      m.swap ? `Swap: ${fmtBytes(m.swap.usedBytes)} / ${fmtBytes(m.swap.totalBytes)} (${m.swap.percent}%)` : null,
      ...m.disk.map((d) => `Disk ${d.mount}: ${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)} (${d.percent}%)`),
      `Network${m.net.iface ? ` (${m.net.iface})` : ''}: ↓ ${fmtBytes(m.net.rxBytesPerSec)}/s ↑ ${fmtBytes(m.net.txBytesPerSec)}/s`,
      m.battery ? `Battery: ${m.battery.percent}%${m.battery.charging ? ' (charging)' : ''}` : null,
      `Uptime: ${uptime}`,
    ];
    return lines.filter(Boolean).join('\n');
  },
});

const listProcesses = defineTool({
  name: 'list_processes',
  description: 'List the top running processes on the user\'s machine, sorted by CPU (default) or memory usage. Read-only.',
  risk: 'safe',
  tag: 'SYS',
  schema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe('How many processes to return (default 10, max 50).'),
    sortBy: z.enum(['cpu', 'mem']).optional().describe('Sort key: "cpu" (default) or "mem".'),
    filter: z.string().optional().describe('Only include processes whose name or command contains this text (case-insensitive).'),
  }),
  run: async ({ limit = 10, sortBy = 'cpu', filter }) => {
    let list = await topProcesses(filter ? 200 : limit, sortBy);
    if (filter) {
      const f = filter.toLowerCase();
      list = list.filter((p) => `${p.name} ${p.command ?? ''}`.toLowerCase().includes(f)).slice(0, limit);
    }
    if (!list.length) return 'No matching processes.';
    return list
      .map((p) => `${String(p.pid).padStart(7)}  ${p.cpu.toFixed(1).padStart(5)}%  ${fmtBytes(p.memBytes).padStart(8)}  ${p.user ?? ''}  ${p.name}`)
      .join('\n');
  },
});

const sendNotification = defineTool({
  name: 'send_notification',
  description:
    "Post a notification to the user's Monarch notification feed and their desktop. Use for things the user should notice later (e.g. results of a background check), not for normal chat replies.",
  risk: 'safe',
  tag: 'SYS',
  schema: z.object({
    title: z.string().min(1).describe('Short title.'),
    body: z.string().describe('Notification text (one or two sentences).'),
    level: z.enum(['info', 'success', 'warn', 'error']).optional().describe('Severity; default "info".'),
  }),
  summarize: (i) => `Notify: ${i.title}`,
  run: ({ title, body, level }) => {
    notify(title, body, level ?? 'info');
    return 'Notification sent.';
  },
});

export const tools: ToolDef[] = [getDatetime, getWeatherTool, systemStatus, listProcesses, sendNotification];
