/** Voice routes: cloud speech-to-text / text-to-speech, core mic capture and playback (see services/voice.ts). */
import type { Hono } from 'hono';
import { HttpError } from '../kernel.ts';
import { deleteVoiceKey, listenOnce, listVoices, setVoiceKey, speak, stopListening, stopSpeaking, transcribe, voiceStatus } from '../services/voice.ts';

export function register(app: Hono): void {
  app.get('/api/voice/status', (c) => c.json(voiceStatus()));
  app.put('/api/voice/key', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    return c.json(setVoiceKey(String(body?.provider ?? ''), String(body?.apiKey ?? '')));
  });
  app.delete('/api/voice/key/:provider', (c) => c.json(deleteVoiceKey(c.req.param('provider'))));
  app.get('/api/voice/voices', async (c) => c.json(await listVoices()));

  app.post('/api/voice/listen', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const maxMs = typeof body?.maxMs === 'number' ? body.maxMs : undefined;
    return c.json({ text: await listenOnce({ maxMs }) });
  });
  app.post('/api/voice/listen/stop', (c) => c.json({ ok: stopListening('stop') }));
  app.post('/api/voice/listen/cancel', (c) => c.json({ ok: stopListening('cancel') }));
  app.post('/api/voice/transcribe', async (c) => {
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length) throw new HttpError(400, 'Empty audio');
    if (buf.length > 25 * 1024 * 1024) throw new HttpError(413, 'Audio too large (25 MB max)');
    const mime = (c.req.header('content-type') || 'audio/wav').split(';')[0]!.trim();
    return c.json({ text: await transcribe(buf, mime) });
  });

  app.post('/api/voice/speak', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const text = typeof body?.text === 'string' ? body.text : '';
    const wav = await speak(text, { play: body?.play });
    if (!wav) return c.json({ ok: true });
    return new Response(new Uint8Array(wav), { headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' } });
  });
  app.post('/api/voice/stop', (c) => c.json({ ok: stopSpeaking() }));
}
