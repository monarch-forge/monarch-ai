/** Core build metadata. */
import pkg from '../../package.json' with { type: 'json' };
import { PROTOCOL_VERSION, type HealthInfo } from '@monarch/shared';
import { getSettings } from '../settings.ts';

export const CORE_VERSION: string = pkg.version;
export const STARTED_AT = new Date().toISOString();

export function healthInfo(): HealthInfo {
  const s = getSettings();
  return {
    ok: true,
    version: CORE_VERSION,
    protocol: PROTOCOL_VERSION,
    startedAt: STARTED_AT,
    engine: s.engine,
    model: s.engine === 'claude-sdk' ? s.claudeSdk.model : s.pi.model,
  };
}
