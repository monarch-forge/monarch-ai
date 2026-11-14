/**
 * Self-evolution runtime: extensions (sandboxed child processes), skills, proposals, timeline, reflection.
 * Public surface used by other core modules:
 *   extensionToolDefs()      live ToolDefs of active extensions (tools/index.ts)
 *   skillsPromptContext()    compact skill list for the system prompt ('' when none)
 *   initEvolution() / shutdownEvolution()   start/stop (index.ts)
 */
export { extensionToolDefs, fullToolName } from './tooldefs.ts';
export { listSkills, getSkill, readSkill, writeSkill, deleteSkill, skillsPromptContext, skillIdFrom } from './skills.ts';
export {
  listExtensions,
  extensionSummary,
  extensionDetail,
  extensionLogs,
  saveExtension,
  toggleExtension,
  reloadExtension,
  rollbackExtension,
  removeExtension,
  setExtensionSecret,
  testExtensionTool,
  extensionPanel,
  type ActivationReport,
} from './service.ts';
export { evolutionStats, acceptProposal, dismissProposal, forge, runReflection } from './evolution.ts';
export { record as recordEvolution, timeline as evolutionTimeline, listProposals, addProposal, getProposal } from './timeline.ts';
export { extensionApiDocs } from './docs.ts';
export { sandboxInfo } from './manager.ts';

import { startExtensions, stopExtensions } from './service.ts';
import { startReflectionTimer, stopReflectionTimer } from './evolution.ts';

export async function initEvolution(): Promise<void> {
  await startExtensions();
  startReflectionTimer();
}

export async function shutdownEvolution(): Promise<void> {
  stopReflectionTimer();
  await stopExtensions();
}
