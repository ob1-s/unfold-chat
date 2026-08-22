// unfold-chat — hosted demo backend: one Worker, static assets + /api/*.
//
//   FREE mode  — env.AI (the app owner's account), metered per visitor + global
//   BYO mode   — the caller's own Cloudflare OAuth bearer is relayed to Workers AI;
//                billed to the visitor's free daily neurons, never the owner's.
//
// The turn state machine and incremental paragraph chunker are ported from
// server.js verbatim; server.js remains the zero-dependency self-host path.

const GUIDED_SYSTEM = {
  role: 'system',
  content: 'Write cohesive sections. Keep short transition sentences with the section they introduce.',
};
const GUIDED_CHUNK_MIN = 140;

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
};

const encoder = new TextEncoder();

function sse(event) {
  return 'data: ' + JSON.stringify(event) + '\n\n';
}

// ---------------------------------------------------------------------------
// Incremental semantic chunker (ported verbatim)
// ---------------------------------------------------------------------------
// Emits content immediately but recognizes blank-line paragraph boundaries
// outside fenced code blocks. A possible delimiter is held just long enough
// to recognize a markdown horizontal rule, which belongs to the section it
// introduces instead of becoming a reveal by itself. Triple-backtick fences
// may be split across upstream frames.

function makeChunker(onText, onBoundary) {
  let inFence = false;
  let tickRun = 0;
  let newlineRun = 0;
  let out = '';
  let pendingBreak = false;
  let candidate = '';
  let marker = '';
  let markerCount = 0;
  let rulePrefix = false;

  const emit = () => {
    if (!out) return;
    onText(out);
    out = '';
  };

  const flushTicks = () => {
    if (!tickRun) return;
    out += '`'.repeat(tickRun);
    if (tickRun >= 3 && tickRun % 3 === 0) inFence = !inFence;
    tickRun = 0;
  };

  const resetCandidate = () => {
    pendingBreak = false;
    candidate = '';
    marker = '';
    markerCount = 0;
  };

  const releaseCandidate = (horizontalRule = false) => {
    emit();
    onBoundary();
    out += candidate;
    resetCandidate();
    rulePrefix = horizontalRule;
  };

  const candidateChar = (ch) => {
    candidate += ch;
    if (ch === ' ' || ch === '\t') return;
    if (!marker) {
      marker = ch;
      markerCount = 1;
      if (ch !== '-' && ch !== '*' && ch !== '_') releaseCandidate();
      return;
    }
    if (ch === marker) {
      markerCount++;
      return;
    }
    releaseCandidate();
  };

  const finishCandidateLine = () => {
    releaseCandidate(markerCount >= 3);
    newlineRun = 1;
  };

  const resolveSpecial = () => {
    if (pendingBreak) {
      releaseCandidate();
      return;
    }
    if (rulePrefix) {
      out += '\n'.repeat(newlineRun);
      newlineRun = 0;
      rulePrefix = false;
      return;
    }
    if (newlineRun === 1) {
      out += '\n';
      newlineRun = 0;
      return;
    }
    if (newlineRun >= 2) {
      emit();
      onBoundary();
      newlineRun = 0;
    }
  };

  const textChar = (ch) => {
    if (pendingBreak) {
      candidateChar(ch);
      return;
    }
    if (rulePrefix) {
      out += '\n'.repeat(newlineRun);
      newlineRun = 0;
      rulePrefix = false;
    } else if (newlineRun === 1) {
      out += '\n';
      newlineRun = 0;
    } else if (newlineRun >= 2) {
      pendingBreak = true;
      candidate = '';
      marker = '';
      markerCount = 0;
      newlineRun = 0;
      candidateChar(ch);
      return;
    }
    out += ch;
  };

  return {
    push(text) {
      if (!text) return;
      for (const ch of text) {
        if (ch === '`') {
          resolveSpecial();
          tickRun++;
          if (tickRun === 3) {
            out += '```';
            inFence = !inFence;
            tickRun = 0;
          }
          continue;
        }

        flushTicks();

        if (ch === '\r') continue;
        if (ch === '\n') {
          if (inFence) {
            out += '\n';
            emit();
          } else if (pendingBreak) {
            finishCandidateLine();
          } else {
            newlineRun++;
          }
          continue;
        }

        textChar(ch);
      }
      emit();
    },
    flush() {
      flushTicks();
      if (pendingBreak) releaseCandidate(markerCount >= 3);
      if (newlineRun) {
        if (inFence || rulePrefix) out += '\n'.repeat(newlineRun);
        else if (newlineRun === 1) out += '\n';
        else {
          emit();
          onBoundary();
        }
        newlineRun = 0;
      }
      emit();
    },
  };
}

// ---------------------------------------------------------------------------
// Upstream parsing
// ---------------------------------------------------------------------------

function extractContent(doc) {
  const choice = doc?.choices?.[0];
  const delta = choice?.delta;
  const msg = choice?.message;
  const candidates = [delta?.content, msg?.content, choice?.text, doc?.message?.content, doc?.response];
  for (const value of candidates) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const text = value.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
      if (text) return text;
    }
  }
  return '';
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Upstream adapters: FREE (env.AI binding) and BYO (caller's bearer → REST)
// ---------------------------------------------------------------------------

async function openUpstream(env, auth) {
  const messages = auth.guided ? [GUIDED_SYSTEM, ...auth.history] : auth.history;

  if (auth.mode === 'free') {
    if (!env.AI) throw new Error('no AI binding configured');
    const result = await env.AI.run(env.MODEL, { messages, stream: true });
    const stream = result instanceof ReadableStream ? result
      : result && typeof result.toReadableStream === 'function' ? result.toReadableStream()
      : null;
    if (!stream) {
      const text = extractContent(result) || String(result ?? '');
      return text ? (async function* () { yield text; })() : emptyStream();
    }
    return sseLineIterator(stream);
  }

  const upstream = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(auth.accountId)}/ai/run/${encodeURIComponent(env.MODEL)}`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + auth.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ messages, stream: true }),
    },
  );
  if (!upstream.ok) {
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 400); } catch {}
    throw new Error('upstream ' + upstream.status + (detail ? ': ' + detail : ''));
  }
  return sseLineIterator(upstream.body);
}

function emptyStream() {
  return (async function* () {})();
}

// Workers AI streams OpenAI-style `data:` frames (REST and binding alike).
async function* sseLineIterator(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        yield line;
      }
    }
    buf += decoder.decode();
    if (buf) yield buf.replace(/\r$/, '');
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Turn state machine (one TurnDO per turn)
// ---------------------------------------------------------------------------

export class TurnDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.turn = null;
    this.writer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/init': return this.init(request);
      case '/continue': await this.ensureTurn(); return json({ ok: true, ...(this.reveal()) });
      case '/cancel': await this.ensureTurn(); await this.supersede(); return json({ ok: true });
      case '/status': {
        const t = await this.ensureTurn();
        if (!t) return json({ error: 'no such turn' }, 404);
        return json({
          status: t.superseded ? 'superseded' : t.status,
          presentation: t.presentation,
          guided: t.guided,
          generationDone: t.generationDone,
          hidden: hiddenCount(t),
          pendingReveal: t.pendingReveal,
          draftCps: pace(t),
          chunks: t.chunks.map((c) => ({ index: c.index, exposed: c.exposed, complete: c.complete, chars: c.text.length })),
        });
      }
      default: return json({ error: 'not found' }, 404);
    }
  }

  async ensureTurn() {
    if (this.turn) return this.turn;
    this.turn = revive(await this.state.storage.get('turn'));
    return this.turn;
  }

  async init(request) {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'invalid JSON body' }, 400);

    const existing = await this.state.storage.get('turn');
    if (existing) return json({ error: 'turn already started' }, 409);

    const turn = {
      id: this.state.id.name,
      presentation: body.presentation === 'full' ? 'full' : 'speculative',
      guided: body.guided === true,
      status: 'starting',
      superseded: false,
      generationDone: false,
      generationError: null,
      chunks: [],
      current: null,
      pendingReveal: false,
      firstTokenAt: 0,
      draftCharsAfterFirst: 0,
      draftCps: 0,
      createdAt: Date.now(),
      history: body.history,
      auth: body.auth,
    };
    this.turn = turn;
    await this.state.storage.put('turn', snapshot(turn));

    const { readable, writable } = new IdentityTransformStream();
    this.writer = writable.getWriter();
    this.write({ type: 'turn', turnId: turn.id });
    this.write({ type: 'state', status: 'starting', hidden: 0, generating: true, waiting: false });

    this.state.waitUntil(this.generate());
    this.state.storage.setAlarm(Date.now() + 60 * 60 * 1000);

    return new Response(readable, { headers: SSE_HEADERS });
  }

  write(event) {
    if (!this.writer) return;
    this.writer.write(encoder.encode(sse(event))).catch(() => {});
  }

  broadcast(event) { this.write(event); }

  closeStream() {
    if (!this.writer) return;
    const w = this.writer;
    this.writer = null;
    w.close().catch(() => {});
  }

  async generate() {
    const t = this.turn;
    if (!t || t.superseded) return;
    t.status = 'streaming';

    let fragments;
    try {
      fragments = await openUpstream(this.env, t.auth);
    } catch (err) {
      if (t.superseded) return;
      t.status = 'error';
      t.generationError = 'upstream request failed: ' + err.message;
      this.broadcast({ type: 'turn_end', status: 'error', error: t.generationError });
      this.closeStream();
      return;
    }

    const chunker = makeChunker(
      (text) => this.appendText(text),
      () => this.endChunk(false),
    );

    try {
      for (;;) {
        const next = await fragments.next();
        if (next.done) break;
        if (t.superseded) return;
        this.feedLine(next.value, chunker, t);
      }
      chunker.flush();
      this.endChunk(true);
      if (t.superseded) return;
      t.generationDone = true;
      t.status = 'generated';
      await this.save();
      this.broadcast({ type: 'generation_end', hidden: hiddenCount(t), cps: pace(t) });
      this.maybeFinish();
    } catch (err) {
      if (t.superseded) return;
      t.status = 'error';
      t.generationError = 'stream error: ' + err.message;
      this.broadcast({ type: 'turn_end', status: 'error', error: t.generationError });
      this.closeStream();
    }
  }

  feedLine(line, chunker, t) {
    if (!line || line.startsWith(':') || /^(event|id|retry):/.test(line)) return;
    if (line.startsWith('data:')) {
      let payload = line.slice(5);
      if (payload.startsWith(' ')) payload = payload.slice(1);
      if (!payload || payload.trim() === '[DONE]') return;
      const doc = parseJson(payload);
      if (doc) {
        const text = extractContent(doc);
        if (text) { this.noteDraft(text, t); chunker.push(text); }
      } else {
        this.noteDraft(payload, t);
        chunker.push(payload);
      }
      return;
    }
    const doc = parseJson(line);
    if (doc) {
      const text = extractContent(doc);
      if (text) { this.noteDraft(text, t); chunker.push(text); }
    }
  }

  noteDraft(text, t) {
    if (!text) return;
    const now = Date.now();
    if (!t.firstTokenAt) {
      t.firstTokenAt = now;
      t.draftCharsAfterFirst = 0;
      return;
    }
    t.draftCharsAfterFirst += text.length;
    const elapsed = now - t.firstTokenAt;
    if (elapsed >= 30 && t.draftCharsAfterFirst > 0) {
      t.draftCps = t.draftCharsAfterFirst * 1000 / elapsed;
    }
  }

  createChunk(t) {
    const index = t.chunks.length;
    const exposed = t.presentation === 'full' || index === 0 || t.pendingReveal;
    if (exposed) t.pendingReveal = false;
    const chunk = { index, text: '', complete: false, exposed };
    t.chunks.push(chunk);
    t.current = chunk;
    if (exposed) this.broadcast({ type: 'chunk_open', index, initial: '', cps: pace(t) });
    else this.emitState();
    return chunk;
  }

  appendText(text) {
    const t = this.turn;
    if (!text || t.superseded) return;
    const chunk = t.current || this.createChunk(t);
    chunk.text += text;
    if (chunk.exposed) this.broadcast({ type: 'delta', index: chunk.index, t: text, cps: pace(t) });
  }

  endChunk(force) {
    const t = this.turn;
    const chunk = t.current;
    if (!chunk || chunk.complete) return;
    if (!chunk.text.trim()) {
      t.chunks.pop();
      t.current = null;
      return;
    }
    // Guided mode keeps a short bridge with the section that follows it; the
    // next boundary closes the combined section, and generation end always
    // closes the final one.
    if (!force && t.guided && chunk.text.trim().length < GUIDED_CHUNK_MIN) {
      this.emitState();
      return;
    }
    chunk.complete = true;
    t.current = null;
    if (chunk.exposed) this.broadcast({ type: 'chunk_end', index: chunk.index });
    this.emitState();
    this.save();
  }

  reveal() {
    const t = this.turn;
    if (!t || t.superseded || t.status === 'error') return { done: true };

    const chunk = t.chunks.find((c) => !c.exposed && (c.text || c.complete));
    if (chunk) {
      chunk.exposed = true;
      this.save();
      this.broadcast({ type: 'chunk_open', index: chunk.index, initial: chunk.text, replay: !!chunk.text, cps: pace(t) });
      if (chunk.complete) this.broadcast({ type: 'chunk_end', index: chunk.index });
      this.emitState();
      this.maybeFinish();
      return { index: chunk.index, replay: !!chunk.text };
    }

    if (!t.generationDone) {
      t.pendingReveal = true;
      this.emitState();
      return { waiting: true };
    }

    this.maybeFinish();
    return { done: true };
  }

  maybeFinish() {
    const t = this.turn;
    if (!t || !t.generationDone || t.superseded || t.status === 'error') return;
    if (hiddenCount(t) > 0) { this.emitState(); return; }
    t.status = 'done';
    this.broadcast({ type: 'turn_end', status: 'done' });
    this.closeStream();
  }

  supersede() {
    const t = this.turn;
    if (!t || t.superseded) return Promise.resolve();
    t.superseded = true;
    t.status = 'superseded';
    t.pendingReveal = false;
    this.broadcast({ type: 'turn_end', status: 'superseded' });
    this.closeStream();
    return this.state.storage.delete('turn');
  }

  emitState() {
    const t = this.turn;
    this.broadcast({
      type: 'state',
      status: t.superseded ? 'superseded' : t.status,
      hidden: hiddenCount(t),
      generating: !t.generationDone && !t.superseded && t.status !== 'error',
      waiting: t.pendingReveal,
      cps: pace(t),
    });
  }

  save() {
    return this.state.storage.put('turn', snapshot(this.turn));
  }

  async alarm() {
    if (!this.turn) {
      this.turn = revive(await this.state.storage.get('turn'));
    }
    if (this.turn && !this.turn.superseded) await this.supersede();
    await this.state.storage.deleteAll();
  }
}

function snapshot(t) {
  return {
    presentation: t.presentation,
    guided: t.guided,
    status: t.status,
    superseded: t.superseded,
    generationDone: t.generationDone,
    generationError: t.generationError,
    pendingReveal: t.pendingReveal,
    draftCps: t.draftCps,
    firstTokenAt: t.firstTokenAt,
    draftCharsAfterFirst: t.draftCharsAfterFirst,
    createdAt: t.createdAt,
    chunks: t.chunks.map((c) => ({ index: c.index, text: c.text, complete: c.complete, exposed: c.exposed })),
    currentIndex: t.current ? t.current.index : null,
  };
}

function revive(saved) {
  if (!saved) return null;
  const t = {
    ...saved,
    current: saved.currentIndex != null ? saved.chunks[saved.currentIndex] : null,
    history: [],
    auth: null,
  };
  return t;
}

function hiddenCount(t) {
  return t.chunks.reduce((n, c) => n + (!c.exposed && (c.text || c.complete) ? 1 : 0), 0);
}

function pace(t) {
  return Number.isFinite(t.draftCps) && t.draftCps > 0 ? Math.round(t.draftCps * 10) / 10 : 0;
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

const unfoldWorker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx, url);
    // The asset root is ./app; server.js self-hosting exposes it under /app/.
    // Rewrite so the same HTML works on both runtimes.
    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
      const inner = new URL(url);
      inner.pathname = url.pathname.slice(4) || '/';
      return env.ASSETS.fetch(new Request(inner, request));
    }
    return env.ASSETS.fetch(request);
  },
};

export { unfoldWorker as default, makeChunker };

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function turnId(sessionId, sessionSeq) {
  return sessionId.slice(0, 40).replace(/[^\w-]/g, '_').slice(0, 40) + ':' + sessionSeq;
}

function doStub(env, name) {
  return env.TURN.get(env.TURN.idFromName(name));
}

async function handleApi(request, env, ctx, url) {
  const path = url.pathname;

  if (request.method === 'GET' && path === '/api/config') {
    const origin = url.origin;
    return json({
      model: env.MODEL,
      byoEnabled: Boolean(env.CLIENT_ID),
      clientId: env.CLIENT_ID || null,
      authUrl: env.AUTH_URL,
      tokenUrl: env.TOKEN_URL,
      scopes: env.SCOPES,
      redirectUri: origin + '/',
      freeLimit: Number(env.FREE_PER_VISITOR),
    });
  }

  if (request.method === 'GET' && path === '/api/quota') {
    return quotaStatus(request, env);
  }

  if (request.method === 'GET' && path === '/api/cf') {
    return cfRelayGet(request);
  }

  if (request.method === 'POST' && path === '/api/stream') {
    return streamRequest(request, env);
  }

  let match = path.match(/^\/api\/turns\/([\w:-]+)\/(continue|cancel)$/);
  if (match && request.method === 'POST') {
    const stub = doStub(env, match[1]);
    return stub.fetch('https://do/' + match[2], { method: 'POST' });
  }

  match = path.match(/^\/api\/turns\/([\w:-]+)$/);
  if (match && request.method === 'GET') {
    const stub = doStub(env, match[1]);
    return stub.fetch('https://do/status', { method: 'GET' });
  }

  return json({ error: 'not found' }, 404);
}

// ---------------------------------------------------------------------------
// Quota (FREE mode): per-visitor daily counter + global daily ceiling in KV.
// Abuse can only ever burn the owner's free daily neurons — this exists to
// keep the demo available for everyone, not to protect money.
// ---------------------------------------------------------------------------

async function ipHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const salt = env.QUOTA_SALT || 'unfold-chat';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + ':' + salt));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function dayKey() {
  const d = new Date();
  const ymd = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  return ymd;
}

async function readQuota(env, visitorKey) {
  const day = dayKey();
  const [used, globalUsed] = await Promise.all([
    env.QUOTA.get('v:' + visitorKey + ':' + day),
    env.QUOTA.get('G:' + day),
  ]);
  return {
    used: Number(used || 0),
    limit: Number(env.FREE_PER_VISITOR),
    globalUsed: Number(globalUsed || 0),
    globalLimit: Number(env.FREE_GLOBAL_DAILY),
    day,
  };
}

async function quotaStatus(request, env) {
  if (!env.QUOTA || !env.AI) return json({ mode: 'unconfigured' });
  const visitorKey = await ipHash(request, env);
  const q = await readQuota(env, visitorKey);
  return json({
    mode: 'free',
    used: q.used,
    limit: q.limit,
    remaining: Math.max(0, q.limit - q.used),
    globalRemaining: Math.max(0, q.globalLimit - q.globalUsed),
  });
}

async function consumeQuota(env, visitorKey, q) {
  const ops = [
    env.QUOTA.put('v:' + visitorKey + ':' + q.day, String(q.used + 1), { expirationTtl: 48 * 3600 }),
    env.QUOTA.put('G:' + q.day, String(q.globalUsed + 1), { expirationTtl: 48 * 3600 }),
  ];
  await Promise.all(ops);
}

async function streamRequest(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'invalid JSON body' }, 400);

  const sessionId = String(body.sessionId || 'default').slice(0, 200);
  const sessionSeq = Number.isFinite(Number(body.sessionSeq)) ? Number(body.sessionSeq) : 0;
  const name = turnId(sessionId, sessionSeq);

  const byo = byoAuth(request);
  let auth;
  if (byo) {
    auth = { ...byo, guided: body.guided === true, history: sanitizeHistory(body.history) };
    if (body.supersede) ctxSafeSupersede(env, String(body.supersede));
  } else {
    if (!env.AI) return json({ error: 'server has no AI binding; connect your own Cloudflare account' }, 503);
    const visitorKey = await ipHash(request, env);
    const q = await readQuota(env, visitorKey);
    if (q.used >= q.limit) {
      return Response.json({ error: 'free_quota_exhausted', used: q.used, limit: q.limit, byoEnabled: Boolean(env.CLIENT_ID) }, { status: 402 });
    }
    if (q.globalUsed >= q.globalLimit) {
      return Response.json({ error: 'demo_busy', retryAfter: 'UTC midnight' }, { status: 429, headers: { 'retry-after': '3600' } });
    }
    await consumeQuota(env, visitorKey, q);
    auth = { mode: 'free', guided: body.guided === true, history: sanitizeHistory(body.history) };
  }

  const stub = doStub(env, name);
  return stub.fetch('https://do/init', {
    method: 'POST',
    body: JSON.stringify({ history: auth.history, presentation: body.presentation === 'full' ? 'full' : 'speculative', guided: auth.guided, auth }),
  });
}

function ctxSafeSupersede(env, oldTurnId) {
  // Best effort: the old turn's DO supersedes itself when reachable.
  doStub(env, oldTurnId).fetch('https://do/cancel', { method: 'POST' }).catch(() => {});
}

function byoAuth(request) {
  const header = request.headers.get('authorization') || '';
  const accountId = (request.headers.get('x-cf-account-id') || '').trim().toLowerCase();
  if (header.startsWith('Bearer ') && /^[0-9a-f]{32}$/.test(accountId)) {
    return { mode: 'byo', bearer: header.slice(7).trim(), accountId };
  }
  return null;
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content || '') }))
    .filter((m) => m.content.length);
  // Adjacent same-role entries are semantically one message; merge only those.
  const merged = [];
  for (const m of clean) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

// Allowlisted passthrough so the connected browser can discover its accounts.
function cfRelayGet(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  if (path !== 'accounts?per_page=5') return json({ error: 'path not allowed' }, 400);
  const auth = request.headers.get('authorization');
  if (!auth || !auth.startsWith('Bearer ')) return json({ error: 'missing bearer token' }, 401);
  return fetch('https://api.cloudflare.com/client/v4/' + path, { headers: { authorization: auth } });
}
