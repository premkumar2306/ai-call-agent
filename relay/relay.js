/**
 * relay.js — Mogi voice relay
 *
 * Twilio Media Streams → STT → Cloudflare Workers (LLM) → TTS → Twilio
 *
 * STT engines  (STT_ENGINE):   deepgram (default) | elevenlabs
 * TTS engines  (TTS_ENGINE):   cartesia (default)   | say (macOS, no API key)
 *
 * Usage:
 *   node relay.js
 *   node --watch relay.js      (dev)
 */

import http          from 'http';
import { spawnSync } from 'child_process';
import { tmpdir }    from 'os';
import { join }      from 'path';
import { unlinkSync } from 'fs';
import { WebSocket, WebSocketServer } from 'ws';
import { ElevenLabsClient, RealtimeEvents } from '@elevenlabs/elevenlabs-js';

const PORT       = process.env.PORT        || 8080;
const RELAY_HOST = process.env.RELAY_HOST;
const STT_ENGINE = (process.env.STT_ENGINE || 'deepgram').toLowerCase();
const TTS_ENGINE = (process.env.TTS_ENGINE || 'cartesia').toLowerCase();
const FILLERS    = ['One moment...', 'Let me check that for you...', 'Almost there...'];
const CARTESIA_VERSION = '2026-03-01';
const CARTESIA_MODEL_ID = process.env.CARTESIA_MODEL_ID || 'sonic-3.5';

console.log(`relay :${PORT}  stt=${STT_ENGINE}  tts=${TTS_ENGINE}`);

process.on('unhandledRejection', (err) => {
  console.error('[unhandled rejection]', err?.stack || err);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaught exception]', err?.stack || err);
});

// ─────────────────────────────────────────────────────────────────────────────
// STT
// ─────────────────────────────────────────────────────────────────────────────

// ElevenLabs realtime STT — server-side VAD, barge-in friendly
async function createElevenLabsSTT(onTranscript) {
  const apiKey = process.env.ELEVENLABS_SPEECH_API_KEY || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('Missing ELEVENLABS_API_KEY or ELEVENLABS_SPEECH_API_KEY');

  const elevenlabs = new ElevenLabsClient({ apiKey });

  const connection = await elevenlabs.speechToText.realtime.connect({
    modelId: 'scribe_v2_realtime',
    audioFormat: { type: 'mulaw', sample_rate: 8000, encoding: 'base64' },
  });

  // Wait until the session is actually ready before accepting audio
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ElevenLabs session timeout')), 10000);
    connection.once(RealtimeEvents.SESSION_STARTED, () => { clearTimeout(timer); resolve(); });
    connection.once(RealtimeEvents.AUTH_ERROR,       () => { clearTimeout(timer); reject(new Error('ElevenLabs auth error')); });
    connection.once(RealtimeEvents.ERROR,            (e) => { clearTimeout(timer); reject(e); });
  });

  let isOpen = true;

  connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (t) => {
    const text = t.text?.trim();
    if (!text) return;
    if (t.is_final) {
      console.log(`[el stt] ${text}`);
      onTranscript(text);
    } else {
      process.stdout.write(`[el stt ~] ${text}\r`);
    }
  });

  connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (t) => {
    const text = t.transcript?.trim();
    if (text) { console.log(`[el stt committed] ${text}`); onTranscript(text); }
  });

  connection.on(RealtimeEvents.CLOSE, () => { isOpen = false; });
  connection.on(RealtimeEvents.ERROR, (e) => { isOpen = false; console.error('[el stt]', e?.message || e); });

  return {
    sendAudio: (buf) => {
      if (!isOpen) return;
      try { connection.send({ audioBase64: buf.toString('base64') }); } catch (e) { isOpen = false; }
    },
    close: () => { isOpen = false; connection.close(); },
  };
}

// Deepgram streaming STT — fallback
const DG_URL = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
  model: 'nova-2', language: 'multi', encoding: 'mulaw', sample_rate: '8000',
  channels: '1', endpointing: '300', interim_results: 'false', smart_format: 'true',
});

function createDeepgramSTT(onTranscript) {
  if (!process.env.DEEPGRAM_API_KEY) throw new Error('Missing DEEPGRAM_API_KEY');

  const ws = new WebSocket(DG_URL, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'Results' || !msg.is_final) return;
    const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
    if (text) { console.log(`[dg stt] ${text}`); onTranscript(text); }
  });

  ws.on('error', (e) => console.error('[dg stt]', e.message));

  return {
    sendAudio: (buf) => { if (ws.readyState === WebSocket.OPEN) ws.send(buf); },
    close:     () => ws.close(),
  };
}

async function createSTT(onTranscript) {
  if (STT_ENGINE === 'deepgram') return createDeepgramSTT(onTranscript);
  return createElevenLabsSTT(onTranscript);
}

// ─────────────────────────────────────────────────────────────────────────────
// TTS
// ─────────────────────────────────────────────────────────────────────────────

const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID ?? 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'; // Skylar - Friendly Guide

// Cartesia streaming TTS
async function cartesiaSpeak(text, streamSid, twWs, signal) {
  if (signal?.aborted) return;
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST', signal,
    headers: {
      'Cartesia-Version': CARTESIA_VERSION,
      'X-API-Key': process.env.CARTESIA_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: CARTESIA_MODEL_ID,
      transcript: text,
      voice: { mode: 'id', id: CARTESIA_VOICE_ID },
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[cartesia]', res.status, body.slice(0, 500));
    return;
  }
  for await (const chunk of res.body) {
    if (signal?.aborted || twWs.readyState !== WebSocket.OPEN) break;
    twWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: Buffer.from(chunk).toString('base64') } }));
  }
  if (!signal?.aborted && twWs.readyState === WebSocket.OPEN)
    twWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'done' } }));
}

// macOS `say` TTS — no API key, great for local dev
// Pipeline: say → AIFF → ffmpeg → µ-law 8 kHz
async function saySpeak(text, streamSid, twWs, signal) {
  if (signal?.aborted) return;
  const tmp = join(tmpdir(), `mogi-${Date.now()}.aiff`);
  try {
    spawnSync('say', ['-v', process.env.SAY_VOICE ?? 'Samantha', '-o', tmp, text]);
    if (signal?.aborted || twWs.readyState !== WebSocket.OPEN) return;

    const ffmpeg = spawnSync('ffmpeg', [
      '-y', '-i', tmp, '-ar', '8000', '-ac', '1', '-f', 'mulaw', '-',
    ], { maxBuffer: 2 * 1024 * 1024 });

    if (ffmpeg.status !== 0) { console.error('[say] ffmpeg failed'); return; }

    const audio = ffmpeg.stdout;
    const CHUNK = 160; // 20 ms at 8 kHz
    for (let i = 0; i < audio.length; i += CHUNK) {
      if (signal?.aborted || twWs.readyState !== WebSocket.OPEN) break;
      twWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: Buffer.from(audio.buffer, i, Math.min(CHUNK, audio.length - i)).toString('base64') } }));
    }
    if (!signal?.aborted && twWs.readyState === WebSocket.OPEN)
      twWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'done' } }));
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function speak(text, streamSid, twWs, signal) {
  console.log(`[tts] "${text}"`);
  if (TTS_ENGINE === 'say') return saySpeak(text, streamSid, twWs, signal);
  return cartesiaSpeak(text, streamSid, twWs, signal);
}

// ─────────────────────────────────────────────────────────────────────────────
// Workers bridge
// ─────────────────────────────────────────────────────────────────────────────

async function turn(transcript, callSid, businessType, signal) {
  const base = `${process.env.WORKERS_URL}/twilio/turn`;
  const url  = businessType ? `${base}?businessType=${encodeURIComponent(businessType)}` : base;
  const res  = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SpeechResult: transcript, CallSid: callSid ?? 'relay' }).toString(),
  });
  const twiml = await res.text();
  return twiml.match(/<Say[^>]*>([\s\S]*?)<\/Say>/i)?.[1]?.trim() ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket server
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }

  if (req.method === 'POST' && req.url?.startsWith('/twilio/inbound')) {
    const inboundParams = new URL(req.url, 'http://x').searchParams;
    const businessType  = inboundParams.get('businessType') || '';
    const host          = RELAY_HOST || req.headers.host;
    const streamUrl     = businessType
      ? `wss://${host}/stream?businessType=${encodeURIComponent(businessType)}`
      : `wss://${host}/stream`;
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<?xml version="1.0"?><Response><Connect><Stream url="${streamUrl}"/></Connect></Response>`);
    return;
  }

  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (twWs, req) => {
  const wsParams    = new URL(req.url, 'http://x').searchParams;
  const businessType = wsParams.get('businessType') || null;

  let callSid, streamSid;
  let busy         = false;
  let currentAbort = null;

  function bargeIn() {
    if (currentAbort) { currentAbort.abort(); currentAbort = null; }
    if (twWs.readyState === WebSocket.OPEN)
      twWs.send(JSON.stringify({ event: 'clear', streamSid }));
    busy = false;
  }

  async function handleTranscript(text) {
    if (busy) {
      console.log(`[barge-in] "${text.slice(0, 40)}"`);
      bargeIn();
    }

    busy = true;
    const ac = new AbortController();
    currentAbort = ac;
    const { signal } = ac;

    try {
      let done = false;
      let fi   = 0;
      const replyPromise = turn(text, callSid, businessType, signal)
        .catch(e => { if (e.name !== 'AbortError') throw e; return null; })
        .finally(() => { done = true; });

      while (!done && !signal.aborted)
        await speak(FILLERS[fi++ % FILLERS.length], streamSid, twWs, signal);

      const reply = await replyPromise;
      if (reply && !signal.aborted)
        await speak(reply, streamSid, twWs, signal);

    } catch (e) {
      if (e.name !== 'AbortError') console.error('[turn]', e.message);
    } finally {
      if (currentAbort === ac) { currentAbort = null; busy = false; }
    }
  }

  // STT is async (ElevenLabs needs await to open WS); use no-op until ready
  let stt = { sendAudio: () => {}, close: () => {} };
  createSTT(handleTranscript)
    .then(s => { stt = s; })
    .catch((e) => {
      console.error('[stt startup]', e?.message || e);
      if (twWs.readyState === WebSocket.OPEN) twWs.close(1011, 'STT startup failed');
    });

  twWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.error('[twilio] invalid message', e?.message || e);
      return;
    }

    if (msg.event === 'start') {
      callSid   = msg.start.callSid;
      streamSid = msg.start.streamSid;
      console.log(`[call] ${callSid.slice(-8)}`);
      busy = true;
      speak("Hi, I'm Mogi. How can I help you today?", streamSid, twWs)
        .catch(e => console.error('[greeting]', e?.message || e))
        .finally(() => { busy = false; });

    } else if (msg.event === 'media') {
      // Always forward — even while busy — so STT can detect barge-in
      stt.sendAudio(Buffer.from(msg.media.payload, 'base64'));

    } else if (msg.event === 'stop') {
      stt.close();
    }
  });

  twWs.on('close', () => {
    if (currentAbort) currentAbort.abort();
    stt.close();
  });

  twWs.on('error', (e) => {
    console.error('[twilio ws]', e?.message || e);
  });
});

server.listen(PORT, '0.0.0.0');
