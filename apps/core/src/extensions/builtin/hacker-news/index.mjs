/**
 * Hacker News — front page + search via the public Algolia HN API (no key needed).
 * Permissions: network (fetch).
 *
 * Shows: tools with zod input + defaults, a shared in-memory cache, ctx.signal for cancellation,
 * and a panel built from the same data.
 */
const API = 'https://hn.algolia.com/api/v1';
const CACHE_MS = 5 * 60_000;

export default function activate(api) {
  const { z } = api;
  let cache = null; // { at: number, stories: Story[] }

  async function getJson(url, signal) {
    const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HN API ${res.status} ${res.statusText}`);
    return res.json();
  }

  const discussion = (id) => `https://news.ycombinator.com/item?id=${id}`;
  const toStory = (h) => ({
    title: h.title || h.story_title || '(untitled)',
    url: h.url || discussion(h.objectID),
    discussion: discussion(h.objectID),
    points: h.points ?? 0,
    comments: h.num_comments ?? 0,
    author: h.author ?? '?',
    createdAt: h.created_at,
  });
  const line = (s, i) =>
    `${i + 1}. ${s.title} — ${s.points} pts, ${s.comments} comments\n   ${s.url}\n   discuss: ${s.discussion}`;

  async function frontPage(limit, signal) {
    if (cache && Date.now() - cache.at < CACHE_MS && cache.stories.length >= limit) return cache.stories.slice(0, limit);
    const data = await getJson(`${API}/search?tags=front_page&hitsPerPage=${Math.max(limit, 30)}`, signal);
    const stories = data.hits.map(toStory).sort((a, b) => b.points - a.points);
    cache = { at: Date.now(), stories };
    return stories.slice(0, limit);
  }

  api.tool({
    name: 'top_stories',
    description: 'Current Hacker News front-page stories, highest score first (title, url, points, comments).',
    risk: 'safe',
    input: z.object({
      limit: z.number().int().min(1).max(30).default(10).describe('How many stories (default 10).'),
    }),
    run: async ({ limit }, ctx) => {
      const stories = await frontPage(limit, ctx.signal);
      return stories.length ? stories.map(line).join('\n') : 'The front page is empty right now.';
    },
  });

  api.tool({
    name: 'search',
    description: 'Search Hacker News stories by keyword. sort=relevance (default) or date (newest first).',
    risk: 'safe',
    input: z.object({
      query: z.string().min(1).describe('Search terms, e.g. "rust async".'),
      sort: z.enum(['relevance', 'date']).default('relevance'),
      limit: z.number().int().min(1).max(30).default(10),
    }),
    run: async ({ query, sort, limit }, ctx) => {
      ctx.progress(`searching "${query}"…`);
      const endpoint = sort === 'date' ? 'search_by_date' : 'search';
      const data = await getJson(
        `${API}/${endpoint}?tags=story&hitsPerPage=${limit}&query=${encodeURIComponent(query)}`,
        ctx.signal,
      );
      if (!data.hits.length) return `No stories found for "${query}".`;
      return data.hits.map(toStory).map(line).join('\n');
    },
  });

  api.panel({
    id: 'front-page',
    title: 'Hacker News',
    render: async () => {
      const stories = await frontPage(10);
      return {
        items: stories.map((s) => ({
          title: s.title,
          sub: `${s.points} pts · ${s.comments} comments · by ${s.author}`,
          href: s.url,
        })),
      };
    },
  });
}
