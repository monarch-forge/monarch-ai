/** Phone access routes (desktop only — the remote listener refuses /api/remote/*). See services/remote.ts. */
import type { Hono } from 'hono';
import { newPairingCode, remoteStatus, revokeDevice, setRemoteConfig } from '../services/remote.ts';

export function register(app: Hono): void {
  app.get('/api/remote/status', async (c) => c.json(await remoteStatus()));
  app.put('/api/remote/config', async (c) => c.json(await setRemoteConfig(((await c.req.json().catch(() => ({}))) ?? {}) as any)));
  app.post('/api/remote/pairing', async (c) => c.json(await newPairingCode()));
  app.delete('/api/remote/devices/:id', async (c) => {
    revokeDevice(c.req.param('id'));
    return c.json(await remoteStatus());
  });
}
