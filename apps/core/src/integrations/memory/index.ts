// Memory vault (Core-C). The first two exports are the cross-module contract — signatures are fixed.
import { ensureVault, promptContext } from './vault.ts';

/** compact text block injected into the system prompt: core facts about the user + recently updated notes (<= ~2k chars) */
export async function memoryPromptContext(): Promise<string> {
  try {
    return await promptContext(2000);
  } catch (e) {
    console.warn('[memory] prompt context failed', e);
    return '';
  }
}
/** called once at startup */
export async function initMemory(): Promise<void> {
  await ensureVault();
}

export {
  appendNote,
  closeVault,
  currentVaultDir,
  deleteNote,
  getGraph,
  getNote,
  linkNotes,
  noteCount,
  noteExists,
  normalizeId,
  putNote,
  recentNotes,
  resolveLink,
  scan,
  searchNotes,
} from './vault.ts';
export type { WriteNoteInput } from './vault.ts';
