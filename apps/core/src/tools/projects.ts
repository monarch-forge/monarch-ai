/** Code projects: the repos Monarch knows and what it detected about each (commands, stack, check). */
import { z } from 'zod';
import { defineTool, type ToolDef } from '../kernel.ts';
import { formatProfile, getRepoProfile, listProjects } from '../services/projects.ts';

const KW = ['repo', 'repository', 'codebase', 'project', 'microservice', 'backend', 'frontend', 'build', 'test command'];

const projectList = defineTool({
  name: 'project_list',
  group: 'projects',
  keywords: KW,
  description: 'List code projects (folders of git repos) with each repo\'s path, stack, commands and the check command run before a worker reports done.',
  risk: 'safe',
  schema: z.object({}),
  summarize: () => 'List code projects',
  run: async () => {
    const list = await listProjects();
    if (!list.length) return 'No projects yet. The user can add a folder in Config → Projects.';
    return list.map((p) => [`# ${p.name} (${p.root})`, ...p.repos.map((r) => formatProfile(r, false))].join('\n\n')).join('\n\n');
  },
});

const repoProfile = defineTool({
  name: 'repo_profile',
  group: 'projects',
  keywords: KW,
  description: 'Detected profile of the git repo at (or containing) a path: stack, install/build/test/lint commands, what CI runs, layout, ports, env vars. Rebuilt automatically when the repo\'s HEAD changes.',
  risk: 'safe',
  schema: z.object({
    path: z.string().describe('Repo folder (or any path inside it).'),
    refresh: z.boolean().optional().describe('Re-detect even if HEAD did not change.'),
  }),
  summarize: (i) => `Repo profile: ${i.path}`,
  run: async ({ path, refresh }) => {
    const p = await getRepoProfile(path, refresh ?? false);
    return p ? formatProfile(p) : `${path} is not inside a git repository.`;
  },
});

export const tools: ToolDef[] = [projectList, repoProfile];
