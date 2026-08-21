// stream-talker: incremental text chat with speculative continuation.
// Node >= 18. No dependencies.
//
// Core invariant:
//   only text actually rendered to the user is ever sent back in a fresh
//   inference context. Hidden speculative continuation is disposable.
//
// Fresh turns use one POST -> SSE request. The browser is attached to the
// stream before upstream inference starts, so the first visible token is
// forwarded immediately instead of arriving later as a catch-up paragraph.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('./app/index.html', import.meta.url), 'utf8');
const ANNOTATION_PAGE = readFileSync(new URL('./app/annotation.html', import.meta.url), 'utf8');
const MIXED_PAGE = readFileSync(new URL('./app/mixed.html', import.meta.url), 'utf8');
const EXPERIMENTS_CSS = readFileSync(new URL('./app/experiments.css', import.meta.url), 'utf8');
const THEME_CSS = readFileSync(new URL('./app/theme.css', import.meta.url), 'utf8');
const EXPERIMENTS_JS = readFileSync(new URL('./app/experiments.js', import.meta.url), 'utf8');
const TRAJECTORIES_PAGE = readFileSync(new URL('./app/trajectories.html', import.meta.url), 'utf8');
const TRAJECTORIES_CSS = readFileSync(new URL('./app/trajectories.css', import.meta.url), 'utf8');
const TRAJECTORIES_DATA = readFileSync(new URL('./app/trajectories-data.js', import.meta.url), 'utf8');
const TRAJECTORIES_JS = readFileSync(new URL('./app/trajectories.js', import.meta.url), 'utf8');

const defaults = {
  model: 'gpt-4o-mini',
  base: 'https://api.openai.com/v1',
  keyVar: 'OPENAI_API_KEY',
  port: 8787,
};

const usage = `usage: node server.js [options]

  -m, --model <name>       model id                       (default: ${defaults.model})
  -b, --base_url <url>     OpenAI-compatible base URL     (default: ${defaults.base})
  -k, --api_key_var <var>  env var holding the API key    (default: ${defaults.keyVar})
  -p, --port <n>           http port                      (default: ${defaults.port})
  -h, --help               this help

'/chat/completions' is appended to the base URL.`;

function parseArgs(args) {
  const out = { ...defaults };
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const eq = raw.indexOf('=');
    const flag = eq < 0 ? raw : raw.slice(0, eq);
    const inline = eq < 0 ? null : raw.slice(eq + 1);
    const take = () => {
      if (inline !== null) return inline;
      const value = args[++i];
      if (value == null || value.startsWith('-')) {
        console.error('missing value for ' + flag + '\n\n' + usage);
        process.exit(1);
      }
      return value;
    };
    if (flag === '-h' || flag === '--help') return null;
    if (flag === '-m' || flag === '--model') out.model = take();
    else if (flag === '-b' || flag === '--base_url') out.base = take();
    else if (flag === '-k' || flag === '--api_key_var') out.keyVar = take();
    else if (flag === '-p' || flag === '--port') out.port = Number(take());
    else {
      console.error('unknown option: ' + flag + '\n\n' + usage);
      process.exit(1);
    }
  }
  return out;
}

const settings = parseArgs(process.argv.slice(2));
if (settings === null) {
  console.log(usage);
  process.exit(0);
}
if (!settings.model || !settings.base || !Number.isFinite(settings.port)) {
  console.error('invalid configuration\n\n' + usage);
  process.exit(1);
}

const apiKey = (process.env[settings.keyVar] || '').trim();
settings.endpoint = settings.base.replace(/\/+$/, '') + '/chat/completions';
if (!apiKey) console.warn('warning: $' + settings.keyVar + ' is empty; Authorization will be omitted');

const GUIDED_SYSTEM = {
  role: 'system',
  content: 'Write cohesive sections. Keep short transition sentences with the section they introduce.',
};
const GUIDED_CHUNK_MIN = 140;

// ---------------------------------------------------------------------------
// Turn state / SSE
// ---------------------------------------------------------------------------

const turns = new Map();
const sessions = new Map();
let turnSeq = 0;

function newTurn(presentation = 'speculative', guided = false) {
  const turn = {
    id: 't' + ++turnSeq,
    presentation,
    guided,
    sessionId: null,
    sessionSeq: 0,
    createdAt: Date.now(),
    status: 'starting',
    ctrl: null,
    superseded: false,
    generationDone: false,
    error: null,
    chunks: [],
    current: null,
    pendingReveal: false,
    sse: new Set(),
    firstTokenAt: 0,
    draftCharsAfterFirst: 0,
    draftCps: 0,
    startedAt: Date.now(),
    visibleChars: 0,
  };
  turns.set(turn.id, turn);
  return turn;
}

function writeSse(res, event) {
  try {
    res.write('data: ' + JSON.stringify(event) + '\n\n');
    return true;
  } catch {
    return false;
  }
}

function broadcast(turn, event) {
  for (const res of [...turn.sse]) {
    if (!writeSse(res, event)) detachSse(turn, res);
  }
}

function attachSse(turn, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.socket?.setNoDelay?.(true);
  turn.sse.add(res);
  res._hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch { detachSse(turn, res); }
  }, 15000);
  const drop = () => detachSse(turn, res);
  res.on('close', drop);
  res.on('error', drop);
}

function detachSse(turn, res) {
  clearInterval(res._hb);
  turn.sse.delete(res);
}

function closeAllSse(turn, event) {
  if (event) broadcast(turn, event);
  for (const res of [...turn.sse]) {
    detachSse(turn, res);
    try { res.end(); } catch {}
  }
}

function hiddenCount(turn) {
  return turn.chunks.reduce((n, c) => n + (!c.exposed && (c.text || c.complete) ? 1 : 0), 0);
}

function turnPace(turn) {
  return Number.isFinite(turn.draftCps) && turn.draftCps > 0 ? Math.round(turn.draftCps * 10) / 10 : 0;
}

function emitState(turn) {
  broadcast(turn, {
    type: 'state',
    status: turn.superseded ? 'superseded' : turn.status,
    hidden: hiddenCount(turn),
    generating: !turn.generationDone && !turn.superseded && turn.status !== 'error',
    waiting: turn.pendingReveal,
    cps: turnPace(turn),
  });
}

function maybeFinishTurn(turn) {
  if (!turn.generationDone || turn.superseded || turn.status === 'error') return;
  if (hiddenCount(turn) > 0) {
    emitState(turn);
    return;
  }
  turn.status = 'done';
  closeAllSse(turn, { type: 'turn_end', status: 'done' });
}

function supersede(turn) {
  if (!turn || turn.superseded) return;
  turn.superseded = true;
  turn.status = 'superseded';
  turn.pendingReveal = false;
  try { turn.ctrl?.abort(); } catch {}
  // Hidden text is intentionally retained nowhere outside this dead turn.
  closeAllSse(turn, { type: 'turn_end', status: 'superseded' });
}

function sweepTurns() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, turn] of turns) {
    if (turn.createdAt < cutoff) {
      supersede(turn);
      if (turn.sessionId) {
        const slot = sessions.get(turn.sessionId);
        if (slot?.turn === turn) sessions.delete(turn.sessionId);
      }
      turns.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Incremental semantic chunker
// ---------------------------------------------------------------------------
// Emits content immediately, but recognizes blank-line paragraph boundaries
// outside fenced code blocks. A possible delimiter is held just long enough
// to recognize a markdown horizontal rule, which belongs to the section it
// introduces instead of becoming a reveal by itself. Triple-backtick fences
// may be split across upstream network frames.

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
    // This newline belongs to the candidate line. If it was a rule, the
    // following newline run must stay with the rule's next section.
    newlineRun = 1;
  };

  const resolveSpecial = () => {
    if (pendingBreak) {
      // A backtick cannot start a horizontal rule. Release any indentation
      // held for the lookahead, then let the normal fence logic handle it.
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
          // A newline run must be resolved before a new token starts.
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
      // Keep a 1-2 backtick prefix across upstream frames so a fenced-code
      // marker split by network packetization is still recognized.
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
// Upstream OpenAI-compatible streaming
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

// Measure the provider's actual drafting throughput after first-token arrival.
// The first delivered fragment is excluded from the numerator because its
// arrival includes model startup / TTFT. Everything after that contributes to
// the running average, including natural pauses in generation.
function noteDraftText(turn, text) {
  if (!text) return;
  const now = Date.now();
  if (!turn.firstTokenAt) {
    turn.firstTokenAt = now;
    turn.draftCharsAfterFirst = 0;
    turn.draftCps = 0;
    return;
  }
  turn.draftCharsAfterFirst += text.length;
  const elapsed = now - turn.firstTokenAt;
  if (elapsed >= 30 && turn.draftCharsAfterFirst > 0) {
    turn.draftCps = turn.draftCharsAfterFirst * 1000 / elapsed;
  }
}

function feedUpstreamLine(raw, chunker, turn) {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (!line || line.startsWith(':') || /^(event|id|retry):/.test(line)) return;

  if (line.startsWith('data:')) {
    let payload = line.slice(5);
    if (payload.startsWith(' ')) payload = payload.slice(1);
    if (!payload || payload.trim() === '[DONE]') return;
    const doc = parseJson(payload);
    if (doc) {
      const text = extractContent(doc);
      if (text) { noteDraftText(turn, text); chunker.push(text); }
    } else {
      noteDraftText(turn, payload);
      chunker.push(payload);
    }
    return;
  }

  const doc = parseJson(line);
  if (doc) {
    const text = extractContent(doc);
    if (text) { noteDraftText(turn, text); chunker.push(text); }
  }
}

function createChunk(turn) {
  const index = turn.chunks.length;
  const exposed = turn.presentation === 'full' || index === 0 || turn.pendingReveal;
  if (exposed) turn.pendingReveal = false;
  const chunk = { index, text: '', complete: false, exposed };
  turn.chunks.push(chunk);
  turn.current = chunk;
  if (exposed) broadcast(turn, { type: 'chunk_open', index, initial: '', cps: turnPace(turn) });
  else emitState(turn);
  return chunk;
}

function appendChunkText(turn, text) {
  if (!text || turn.superseded) return;
  const chunk = turn.current || createChunk(turn);
  chunk.text += text;
  if (chunk.exposed) {
    turn.visibleChars += text.length;
    broadcast(turn, { type: 'delta', index: chunk.index, t: text, cps: turnPace(turn) });
  }
}

function endChunk(turn, force = false) {
  const chunk = turn.current;
  if (!chunk || chunk.complete) return;
  // Avoid materializing empty chunks from repeated blank lines.
  if (!chunk.text.trim()) {
    turn.chunks.pop();
    turn.current = null;
    return;
  }
  // Guided mode keeps a short bridge with the content that follows it. The
  // next boundary will close the combined section; generation end always
  // closes the final chunk.
  if (!force && turn.guided && chunk.text.trim().length < GUIDED_CHUNK_MIN) {
    emitState(turn);
    return;
  }
  chunk.complete = true;
  turn.current = null;
  if (chunk.exposed) broadcast(turn, { type: 'chunk_end', index: chunk.index });
  emitState(turn);
}

function revealNext(turn) {
  if (!turn || turn.superseded || turn.status === 'error') return { ok: false, done: true };

  const chunk = turn.chunks.find((c) => !c.exposed && (c.text || c.complete));
  if (chunk) {
    chunk.exposed = true;
    broadcast(turn, { type: 'chunk_open', index: chunk.index, initial: chunk.text, replay: !!chunk.text, cps: turnPace(turn) });
    if (chunk.complete) broadcast(turn, { type: 'chunk_end', index: chunk.index });
    emitState(turn);
    maybeFinishTurn(turn);
    return { ok: true, index: chunk.index, replay: !!chunk.text };
  }

  if (!turn.generationDone) {
    turn.pendingReveal = true;
    emitState(turn);
    return { ok: true, waiting: true };
  }

  maybeFinishTurn(turn);
  return { ok: true, done: true };
}

async function generate(history, turn) {
  const ctrl = new AbortController();
  turn.ctrl = ctrl;
  turn.status = 'streaming';
  emitState(turn);

  let upstream;
  try {
    upstream = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages: turn.guided ? [GUIDED_SYSTEM, ...history] : history,
        stream: true,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (turn.superseded) return;
    turn.status = 'error';
    turn.error = 'upstream request failed: ' + err.message;
    closeAllSse(turn, { type: 'turn_end', status: 'error', error: turn.error });
    return;
  }

  if (turn.superseded) return;
  if (!upstream.ok) {
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 800); } catch {}
    turn.status = 'error';
    turn.error = 'upstream ' + upstream.status + ' ' + upstream.statusText + (detail ? ': ' + detail : '');
    closeAllSse(turn, { type: 'turn_end', status: 'error', error: turn.error });
    return;
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    turn.status = 'error';
    turn.error = 'upstream returned no stream body';
    closeAllSse(turn, { type: 'turn_end', status: 'error', error: turn.error });
    return;
  }

  const chunker = makeChunker(
    (text) => appendChunkText(turn, text),
    () => endChunk(turn),
  );

  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (turn.superseded) return;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        feedUpstreamLine(line, chunker, turn);
      }
    }
    buf += decoder.decode();
    if (buf) feedUpstreamLine(buf, chunker, turn);
    chunker.flush();
    endChunk(turn, true);
    if (turn.superseded) return;
    turn.generationDone = true;
    turn.status = 'generated';
    broadcast(turn, { type: 'generation_end', hidden: hiddenCount(turn), cps: turnPace(turn) });
    maybeFinishTurn(turn);
  } catch (err) {
    if (turn.superseded || err?.name === 'AbortError') return;
    turn.status = 'error';
    turn.error = 'stream error: ' + err.message;
    closeAllSse(turn, { type: 'turn_end', status: 'error', error: turn.error });
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function json(res, code, value) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (done) return;
      data += chunk;
      if (data.length > 2_000_000) {
        done = true;
        resolve(null);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (done) return;
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); }
    });
    req.on('error', () => { if (!done) resolve(null); });
  });
}

function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const clean = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content || '') }))
    .filter((m) => m.content.length);
  // Many open-model chat templates prefer alternating roles. Incremental UI
  // segments from the same speaker are semantically one message, so merge only
  // adjacent equal-role entries; ACKs/interventions still preserve ordering.
  const merged = [];
  for (const m of clean) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  return merged;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
  if (req.method === 'GET' && (path === '/annotation' || path === '/annotation.html')) {
    return send(res, 200, 'text/html; charset=utf-8', ANNOTATION_PAGE);
  }
  if (req.method === 'GET' && (path === '/mixed' || path === '/mixed.html')) {
    return send(res, 200, 'text/html; charset=utf-8', MIXED_PAGE);
  }
  if (req.method === 'GET' && (path === '/trajectories' || path === '/trajectories.html')) {
    return send(res, 200, 'text/html; charset=utf-8', TRAJECTORIES_PAGE);
  }
  if (req.method === 'GET' && path === '/app/experiments.css') {
    return send(res, 200, 'text/css; charset=utf-8', EXPERIMENTS_CSS);
  }
  if (req.method === 'GET' && path === '/app/theme.css') {
    return send(res, 200, 'text/css; charset=utf-8', THEME_CSS);
  }
  if (req.method === 'GET' && path === '/app/experiments.js') {
    return send(res, 200, 'text/javascript; charset=utf-8', EXPERIMENTS_JS);
  }
  if (req.method === 'GET' && path === '/app/trajectories.css') {
    return send(res, 200, 'text/css; charset=utf-8', TRAJECTORIES_CSS);
  }
  if (req.method === 'GET' && path === '/app/trajectories-data.js') {
    return send(res, 200, 'text/javascript; charset=utf-8', TRAJECTORIES_DATA);
  }
  if (req.method === 'GET' && path === '/app/trajectories.js') {
    return send(res, 200, 'text/javascript; charset=utf-8', TRAJECTORIES_JS);
  }
  if (req.method === 'GET' && path === '/favicon.ico') return send(res, 204, 'text/plain', '');

  // A fresh inference is one streaming request. We attach SSE first, send the
  // turn id, and only then start upstream generation on the next microtask.
  if (req.method === 'POST' && path === '/api/stream') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'invalid JSON body' });
    sweepTurns();

    const sessionId = String(body.sessionId || 'default').slice(0, 200);
    const sessionSeq = Number.isFinite(Number(body.sessionSeq)) ? Number(body.sessionSeq) : 0;
    const presentation = body.presentation === 'full' ? 'full' : 'speculative';
    const guided = body.guided === true;
    const slot = sessions.get(sessionId);
    if (slot && sessionSeq && sessionSeq <= slot.seq) {
      return json(res, 409, { error: 'stale turn request' });
    }
    const old = slot?.turn || (body.supersede ? turns.get(String(body.supersede)) : null);
    if (old) supersede(old);

    const history = sanitizeHistory(body.history);
    const turn = newTurn(presentation, guided);
    turn.sessionId = sessionId;
    turn.sessionSeq = sessionSeq;
    sessions.set(sessionId, { seq: sessionSeq, turn });
    attachSse(turn, res);
    writeSse(res, { type: 'turn', turnId: turn.id });
    writeSse(res, { type: 'state', status: 'starting', hidden: 0, generating: true, waiting: false });
    queueMicrotask(() => generate(history, turn));
    return;
  }

  let match = path.match(/^\/api\/turns\/([\w-]+)\/continue$/);
  if (match && req.method === 'POST') {
    const turn = turns.get(match[1]);
    if (!turn) return json(res, 404, { error: 'no such turn' });
    return json(res, 200, revealNext(turn));
  }

  match = path.match(/^\/api\/turns\/([\w-]+)\/cancel$/);
  if (match && req.method === 'POST') {
    const turn = turns.get(match[1]);
    if (!turn) return json(res, 404, { error: 'no such turn' });
    supersede(turn);
    return json(res, 200, { ok: true });
  }

  match = path.match(/^\/api\/turns\/([\w-]+)$/);
  if (match && req.method === 'GET') {
    const turn = turns.get(match[1]);
    if (!turn) return json(res, 404, { error: 'no such turn' });
    return json(res, 200, {
      status: turn.status,
      presentation: turn.presentation,
      guided: turn.guided,
      generationDone: turn.generationDone,
      hidden: hiddenCount(turn),
      pendingReveal: turn.pendingReveal,
      draftCps: turnPace(turn),
      chunks: turn.chunks.map((c) => ({ index: c.index, exposed: c.exposed, complete: c.complete, chars: c.text.length })),
    });
  }

  send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

server.listen(settings.port, () => {
  console.log('stream-talker -> http://localhost:' + settings.port);
  console.log('  model:    ' + settings.model);
  console.log('  endpoint: ' + settings.endpoint);
  console.log('  key:      $' + settings.keyVar + (apiKey ? '' : ' (empty)'));
});
