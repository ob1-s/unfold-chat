// stream-talker: incremental text chat with speculative continuation.
// One file. Node >= 18 (fetch). No dependencies.
//
// How it works:
//   POST /api/turns            {history}            -> start generating, {turnId}
//     the upstream stream is split into paragraph chunks: the FIRST paragraph
//     is pushed to the client live over SSE as its tokens arrive; everything
//     after it is buffered server-side and hidden until a reveal.
//   GET  /api/turns/:id        -> {status, buffered, revealed, total, error}
//   GET  /api/turns/:id/stream -> SSE: 'initial' (catch-up if you connect
//     late), 'delta' (live first-paragraph tokens), 'end' (paragraph done +
//     measured generation tokens/sec), 'buffered' (draft progress), 'status'
//     (done / error / superseded, then the stream closes). Hidden draft text
//     is never emitted on this stream or anywhere else.
//   POST /api/turns/:id/reveal -> reveal exactly one buffered chunk
//   POST /api/message          {turnId, history, text}
//     acks ('yeah', 'ok', 'lol', ...) are recorded as microturns; the draft
//     keeps streaming and later chunks keep buffering. anything else
//     supersedes the current draft and starts a fresh inference whose context
//     is ONLY the visible history + recorded microturns + the new message —
//     unseen buffered text can never leak into model context.
//
// The client plays revealed chunks back at roughly the tokens/sec the first
// paragraph was actually generated at, so Continue feels like native
// streaming. Swap the Chunker (paragraph split) for other chunking freely.

import { createServer } from 'node:http';

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

'/chat/completions' is appended to the base URL. For ollama use its OpenAI
compat endpoint: -b http://localhost:11434/v1`;

function parseArgs(args) {
  const o = { ...defaults };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const take = () => {
      if (inline !== undefined) return inline;
      const v = args[i + 1];
      if (v === undefined || v.startsWith('-')) {
        console.error('missing value for ' + flag + '\n\n' + usage);
        process.exit(1);
      }
      return args[++i];
    };
    if (flag === '-h' || flag === '--help') return null;
    if (flag === '-m' || flag === '--model') o.model = take();
    else if (flag === '-b' || flag === '--base_url') o.base = take();
    else if (flag === '-k' || flag === '--api_key_var') o.keyVar = take();
    else if (flag === '-p' || flag === '--port') o.port = Number(take());
    else {
      console.error('unknown option: ' + flag + '\n\n' + usage);
      process.exit(1);
    }
  }
  return o;
}

const settings = parseArgs(process.argv.slice(2));
if (settings === null) {
  console.log(usage);
  process.exit(0);
}
if (!settings.model || !settings.base) {
  console.error('model and base_url are required\n\n' + usage);
  process.exit(1);
}
if (!Number.isFinite(settings.port)) {
  console.error('invalid port\n\n' + usage);
  process.exit(1);
}

const apiKey = (process.env[settings.keyVar] || '').trim();
if (!apiKey) console.warn('warning: no API key in $' + settings.keyVar + ' — requests will omit Authorization');
settings.endpoint = settings.base.replace(/\/+$/, '') + '/chat/completions';

const SYSTEM = {
  role: 'system',
  content:
    'You are a friendly conversational partner in a text chat. Reply in plain, natural language, typically one to three short paragraphs. Do not mention chat software, buffering, or that you are an AI model.',
};

// ---------- ack vs intervention heuristic ----------

const ACKS = new Set([
  'yeah', 'yep', 'yup', 'yea', 'yes', 'yesss', 'ok', 'okay', 'okkk', 'k', 'kk', 'sure', 'sure thing',
  'right', 'exactly', 'indeed', 'true', 'true true', 'very true', 'fair', 'fair enough', 'gotcha',
  'lol', 'lmao', 'haha', 'hahaha', 'hahahaha', 'ha', 'hehe', 'lolz', 'nice', 'nice one', 'cool',
  'cool cool', 'wow', 'whoa', 'ooh', 'aah', 'dope', 'sick', 'awesome', 'noice', 'ty', 'thx', 'thanks',
  'oh', 'ah', 'uh', 'huh', 'hmm', 'hm', 'mm', 'mhm', 'mhmm', 'uhuh', 'oh ok', 'oh okay', 'ohhh',
  'i see', 'got it', 'makes sense', 'that makes sense', 'i hear you', 'no way', 'for real',
  'yeah yeah', 'yeah lol', 'lol yeah', 'oh yeah', 'yep yep', 'ok ok', 'okay okay', 'interesting',
  'ok cool', 'cool cool cool', 'ahh', 'sounds good', 'got it', 'aight', 'bet',
]);

function isAck(text) {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"()[\]{}]+$/g, '')
    .replace(/[.,!?;:'"()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s]+$/u.test(t) && t.trim().length <= 8) return true;
  if (ACKS.has(t)) return true;
  if (t.length <= 2) return true;
  const words = t.split(' ');
  return words.length <= 2 && words.every((w) => ACKS.has(w));
}

// ---------- stream chunking (paragraph boundaries; replace freely) ----------

// onVisible: raw fragment of the still-open FIRST paragraph (streamed live)
// onFirst:   first paragraph completed (streamed end-to-end to the client)
// onChunk:   any later paragraph (hidden draft — buffered until a reveal)
function makeChunker(onVisible, onFirst, onChunk) {
  let pending = '';
  let firstDone = false;
  const fenceOpen = () => (pending.match(/```/g) || []).length % 2 === 1;
  return {
    push(part) {
      if (!part) return;
      pending += part;
      if (!firstDone && onVisible) {
        if (fenceOpen() || pending.indexOf('\n\n') === -1) {
          onVisible(part);
          return;
        }
        const off = pending.length - part.length;
        const i = pending.indexOf('\n\n');
        const vis = part.slice(0, Math.max(0, i - off));
        if (vis) onVisible(vis);
        const para0 = pending.slice(0, i).replace(/\s+$/, '');
        pending = pending.slice(i + 2);
        if (para0) {
          firstDone = true;
          onFirst(para0);
        }
      }
      if (fenceOpen()) return;
      let cut;
      while ((cut = pending.indexOf('\n\n')) !== -1) {
        const para = pending.slice(0, cut).replace(/\s+$/, '');
        pending = pending.slice(cut + 2);
        if (!para) continue;
        if (!firstDone) {
          firstDone = true;
          onFirst(para);
        } else {
          onChunk(para);
        }
      }
    },
    flush() {
      const rest = pending.replace(/^\s+|\s+$/g, '');
      pending = '';
      if (!rest) return;
      if (!firstDone) onFirst(rest);
      else onChunk(rest);
    },
  };
}

// ---------- turn state ----------

const turns = new Map();
let seq = 0;

function broadcast(turn, obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of turn.sse) {
    try {
      res.write(line);
    } catch {}
  }
}

function endSse(turn, obj) {
  broadcast(turn, obj);
  for (const res of turn.sse) {
    try {
      clearInterval(res._hb);
      res.end();
    } catch {}
  }
  turn.sse.clear();
}

function startTurn(ctx) {
  const turn = {
    id: 't' + ++seq,
    status: 'pending',
    chunks: [],
    revealed: 0,
    micros: [],
    error: null,
    superseded: false,
    ctrl: null,
    sse: new Set(),
    sseEver: false,
    firstDone: false,
    liveText: '',
    liveChars: 0,
    liveStart: 0,
    tps: null,
    created: Date.now(),
  };
  turns.set(turn.id, turn);
  generate(ctx, turn);
  return turn;
}

function supersede(turn) {
  turn.superseded = true;
  try {
    turn.ctrl && turn.ctrl.abort();
  } catch {}
  turn.chunks = turn.chunks.slice(0, turn.revealed); // discard all unseen specul(ation)
  endSse(turn, { type: 'status', status: 'superseded' });
}

function sweepTurns() {
  const now = Date.now();
  for (const [id, t] of turns) if (now - t.created > 3600e3) turns.delete(id);
}

// ---------- upstream generation ----------

function extractContent(doc) {
  const d = doc.choices && doc.choices[0];
  if (d) {
    if (d.delta && typeof d.delta.content === 'string') return d.delta.content;
    if (d.message && typeof d.message.content === 'string') return d.message.content;
    if (typeof d.text === 'string') return d.text;
  }
  if (doc.message && typeof doc.message.content === 'string') return doc.message.content;
  if (typeof doc.response === 'string') return doc.response;
  return null;
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function feedLine(raw, chunker) {
  const line = raw.trim();
  if (!line || line.startsWith(':')) return;
  if (/^(event|id|retry):/.test(line)) return;
  if (line.startsWith('data:')) {
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const json = tryJson(payload);
    if (json) {
      const c = extractContent(json);
      if (c) chunker.push(c);
      return;
    }
    chunker.push(payload); // non-JSON data: treat as raw text
    return;
  }
  const json = tryJson(line); // json-per-line providers (ollama style)
  if (json) {
    const c = extractContent(json);
    if (c) chunker.push(c);
  }
}

async function generate(ctx, turn) {
  const ctrl = new AbortController();
  turn.ctrl = ctrl;
  turn.status = 'streaming';
  let res;
  try {
    res = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages: ctx,
        stream: true,
        temperature: 0.7,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (!turn.superseded) {
      turn.status = 'error';
      turn.error = 'upstream request failed: ' + err.message;
      endSse(turn, { type: 'status', status: 'error', error: turn.error });
    }
    return;
  }
  if (turn.superseded) return;
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {}
    turn.status = 'error';
    turn.error = 'upstream ' + res.status + ' ' + res.statusText + ': ' + detail;
    endSse(turn, { type: 'status', status: 'error', error: turn.error });
    return;
  }
  const reader = res.body ? res.body.getReader() : null;
  if (!reader) {
    turn.status = 'error';
    turn.error = 'empty upstream body';
    endSse(turn, { type: 'status', status: 'error', error: turn.error });
    return;
  }
  const chunker = makeChunker(
    (frag) => {
      // visible first-paragraph fragment — forwarded live to every listener
      if (turn.superseded) return;
      if (!turn.liveStart) turn.liveStart = Date.now();
      turn.liveChars += frag.length;
      turn.liveText += frag;
      broadcast(turn, { type: 'delta', t: frag });
    },
    (para0) => {
      // first paragraph complete — the client has seen every char of it
      if (turn.superseded) return;
      turn.firstDone = true;
      turn.chunks.push(para0);
      const secs = (Date.now() - turn.liveStart) / 1000;
      const est = turn.liveChars / 4; // chars ~= 4 tokens
      if (secs > 0.15 && est > 0) turn.tps = +((est / secs).toFixed(1));
      if (turn.sseEver) turn.revealed = 1; // fully streamed, never re-revealed
      broadcast(turn, { type: 'end', tps: turn.tps });
      broadcast(turn, { type: 'buffered', n: turn.chunks.length - turn.revealed });
    },
    (para) => {
      // hidden draft paragraph — buffered, reported as count only
      if (turn.superseded) return;
      turn.chunks.push(para);
      broadcast(turn, { type: 'buffered', n: turn.chunks.length - turn.revealed });
    }
  );
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (turn.superseded) {
        ctrl.abort();
        break;
      }
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        feedLine(line, chunker);
      }
    }
    if (turn.superseded) return;
    if (buf.trim()) feedLine(buf, chunker);
    chunker.flush();
    turn.status = 'done';
    endSse(turn, { type: 'status', status: 'done', buffered: statusOf(turn).buffered });
  } catch (err) {
    if (turn.superseded) return;
    turn.status = 'error';
    turn.error = 'stream error: ' + err.message;
    endSse(turn, { type: 'status', status: 'error', error: turn.error });
  }
}

// ---------- http ----------

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) {
        req.destroy();
        resolve({});
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const statusOf = (turn) => ({
  status: turn.superseded ? 'superseded' : turn.status,
  buffered: turn.chunks.length - turn.revealed,
  revealed: turn.revealed,
  total: turn.chunks.length,
  error: turn.error || undefined,
});

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;

  if (req.method === 'GET' && path === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
  if (req.method === 'GET' && path === '/favicon.ico') return send(res, 204, 'text/plain', '');

  if (req.method === 'POST' && path === '/api/turns') {
    const body = await readBody(req);
    sweepTurns();
    const history = Array.isArray(body.history) ? body.history : [];
    const ctx = [SYSTEM, ...history.map((m) => ({ role: m.role, content: String(m.content) }))];
    const turn = startTurn(ctx);
    return send(res, 200, 'application/json', JSON.stringify({ turnId: turn.id }));
  }

  let m = path.match(/^\/api\/turns\/([\w-]+)$/);
  if (m && req.method === 'GET') {
    const turn = turns.get(m[1]);
    if (!turn) return send(res, 404, 'application/json', JSON.stringify({ error: 'no such turn' }));
    return send(res, 200, 'application/json', JSON.stringify(statusOf(turn)));
  }
  m = path.match(/^\/api\/turns\/([\w-]+)\/reveal$/);
  if (m && req.method === 'POST') {
    const turn = turns.get(m[1]);
    if (!turn) return send(res, 404, 'application/json', JSON.stringify({ error: 'no such turn' }));
    if (turn.superseded || turn.revealed >= turn.chunks.length)
      return send(res, 200, 'application/json', JSON.stringify({ content: null, more: false }));
    const idx = turn.revealed++;
    return send(res, 200, 'application/json', JSON.stringify({ content: turn.chunks[idx], more: turn.revealed < turn.chunks.length }));
  }

  m = path.match(/^\/api\/turns\/([\w-]+)\/stream$/);
  if (m && req.method === 'GET') {
    const turn = turns.get(m[1]);
    if (!turn) return send(res, 404, 'application/json', JSON.stringify({ error: 'no such turn' }));
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    turn.sseEver = true;
    const snap = turn.liveText; // frozen before attach: no dup, no gap
    const firstDone = turn.firstDone;
    turn.sse.add(res);
    res.write(': connected\n\n');
    // catch-up: a connection that joins after paragraph 0 finished must get
    // its full text (initial replaces, never appends, so reconnects are safe)
    if (firstDone) {
      if (turn.revealed === 0) turn.revealed = 1; // replayed below, never re-revealed
      res.write('data: ' + JSON.stringify({ type: 'initial', t: turn.chunks[0] || '' }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'end', tps: turn.tps }) + '\n\n');
    } else if (snap) {
      res.write('data: ' + JSON.stringify({ type: 'initial', t: snap }) + '\n\n');
    }
    if (turn.superseded || turn.status === 'done' || turn.status === 'error') {
      res.write(
        'data: ' +
          JSON.stringify({
            type: 'status',
            status: turn.superseded ? 'superseded' : turn.status,
            buffered: statusOf(turn).buffered,
            error: turn.error,
          }) +
          '\n\n'
      );
      turn.sse.delete(res);
      return res.end();
    }
    res._hb = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {}
    }, 15e3);
    const drop = () => {
      clearInterval(res._hb);
      turn.sse.delete(res);
    };
    res.on('close', drop);
    res.on('error', drop);
    return;
  }

  if (req.method === 'POST' && path === '/api/message') {
    const body = await readBody(req);
    sweepTurns();
    const text = String(body.text || '').trim();
    if (!text) return send(res, 400, 'application/json', JSON.stringify({ error: 'empty text' }));
    const history = Array.isArray(body.history) ? body.history : [];
    const old = body.turnId ? turns.get(String(body.turnId)) : null;

    let content = text;
    const quote = body.quote && typeof body.quote === 'object' ? body.quote : null;
    if (quote) {
      const qt = quote.turnId ? turns.get(String(quote.turnId)) : null;
      const qi = Number(quote.chunkIdx);
      if (!qt || !Number.isInteger(qi) || qi < 0 || qi >= qt.revealed)
        return send(res, 400, 'application/json', JSON.stringify({ error: 'quote must reference a visible paragraph' }));
      content = 'Regarding your earlier point — "' + qt.chunks[qi] + '":\n\n' + text;
    }

    if (!quote && old && isAck(text)) {
      old.micros.push({ role: 'user', content: text });
      return send(res, 200, 'application/json', JSON.stringify({ kind: 'ack', turnId: old.id }));
    }

    const draftPending = old && (old.status === 'streaming' || old.chunks.length > old.revealed);
    if (draftPending) supersede(old);

    const ctx = [
      SYSTEM,
      ...history.map((x) => ({ role: x.role, content: String(x.content) })),
      ...(old && old.micros.length ? old.micros.map((x) => ({ role: x.role, content: x.content })) : []),
      { role: 'user', content },
    ];
    const turn = startTurn(ctx);
    return send(res, 200, 'application/json', JSON.stringify({ kind: 'new', turnId: turn.id, content }));
  }

  send(res, 404, 'text/plain', 'not found');
});

server.listen(settings.port, () => {
  console.log('stream-talker → http://localhost:' + settings.port);
  console.log('  model:   ' + settings.model);
  console.log('  endpoint:' + settings.endpoint);
  console.log('  key:     $' + settings.keyVar + (apiKey ? '' : ' (empty)'));
});

// ======================================================================
// ==================== embedded page (HTML + CSS + JS) ==================
// ======================================================================

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stream talker</title>
<style>
*{box-sizing:border-box}
:root{
  --bg:#0d1017; --panel:#151a24; --ink:#e9ecf3; --muted:#8c94a8;
  --accent:#6e8bff; --accent2:#9a6eff; --line:#232a38;
}
html,body{height:100%}
body{margin:0;background:linear-gradient(180deg,#0b0e18,var(--bg) 40%);color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.app{width:100%;max-width:760px;height:100%;margin:0 auto;display:flex;flex-direction:column;padding:0 16px}
header{display:flex;align-items:baseline;gap:12px;padding:14px 2px 12px;border-bottom:1px solid var(--line)}
.brand{font-weight:700;letter-spacing:.2px}.brand b{color:var(--accent)}
#status{margin-left:auto;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:7px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}
.dot.live{background:var(--accent);animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
main{flex:1;overflow-y:auto;padding:18px 2px 10px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:84%;padding:10px 13px;border-radius:14px;animation:rise .25s ease;word-wrap:break-word}
.msg.user{align-self:flex-end;background:linear-gradient(135deg,#24356b,#1f2a4e);border-bottom-right-radius:4px}
.msg.assistant{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:4px}
.msg.ack{align-self:flex-end;max-width:60%;font-size:12px;color:var(--muted);background:none;border:none;padding:2px 6px;font-style:italic}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
.chunk{animation:rise .4s ease;position:relative;padding-right:6px}
.chunk+.chunk{border-top:1px dashed var(--line);margin-top:9px;padding-top:9px}
.replybtn{position:absolute;top:4px;right:0;display:none;border:1px solid var(--line);background:var(--panel);
  color:var(--muted);font:11px/1 inherit;border-radius:8px;padding:2px 8px;cursor:pointer}
.chunk.playing{cursor:pointer}
.chunk:hover .replybtn,.replybtn:focus{display:block}
.replybtn:hover{color:var(--accent);border-color:var(--accent)}
.quotechip{display:flex;align-items:center;gap:8px;background:var(--panel);border:1px dashed var(--line);
  border-left:3px solid var(--accent);border-radius:10px;padding:6px 10px;margin-bottom:8px;
  font-size:12px;color:var(--muted);max-width:100%}
.quotechip[hidden]{display:none}
.quotechip-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.quotechip button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;line-height:1;flex:none}
.quotechip button:hover{color:var(--accent)}
.quote-block{border-left:3px solid var(--accent);padding-left:8px;margin-bottom:6px;
  font-size:12px;color:var(--muted);font-style:italic}
.chunk p{margin:.35em 0}
.chunk p:first-child{margin-top:0}.chunk p:last-child{margin-bottom:0}
.chunk h1,.chunk h2,.chunk h3{margin:.5em 0 .3em;line-height:1.25}
.chunk h1{font-size:1.35em}.chunk h2{font-size:1.2em}.chunk h3{font-size:1.05em}
.chunk ul,.chunk ol{margin:.4em 0;padding-left:1.4em}
.chunk pre{background:#0b0e16;border:1px solid var(--line);border-radius:10px;padding:10px 12px;overflow-x:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.chunk code{font:inherit;background:rgba(255,255,255,.07);padding:.1em .35em;border-radius:5px}
.chunk pre code{background:none;padding:0}
.chunk a{color:var(--accent)}
.chunk del{color:var(--muted)}
.caret{display:inline-block;width:8px;height:15px;background:var(--accent);border-radius:2px;margin:8px 0 0 6px;vertical-align:middle;animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
footer{padding:10px 0 14px}
.actions{display:flex;justify-content:flex-end;margin-bottom:9px;min-height:36px}
#continue{display:none;align-items:center;gap:8px;padding:8px 16px;border-radius:20px;border:0;cursor:pointer;
  background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font:600 14px/1 inherit;
  box-shadow:0 2px 16px rgba(110,139,255,.35);animation:rise .2s ease;transition:opacity .15s}
#continue.on{display:inline-flex}
#continue:disabled{opacity:.5;cursor:default;box-shadow:none}
.badge{background:rgba(255,255,255,.22);border-radius:9px;padding:0 7px;font-size:11px;font-weight:600}
.composer{display:flex;gap:10px;align-items:flex-end}
textarea{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:14px;color:var(--ink);
  padding:11px 14px;font:inherit;resize:none;max-height:160px;outline:none}
textarea:focus{border-color:var(--accent)}
#send{padding:11px 20px;border-radius:14px;border:1px solid var(--line);background:var(--panel);color:var(--ink);
  cursor:pointer;font:600 14px/1 inherit}
#send:hover{border-color:var(--accent);color:var(--accent)}
.hint{margin-top:8px;font-size:11px;color:var(--muted)}
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand">stream<b>talker</b></div>
    <div id="status"><span class="dot" id="dot"></span><span id="statustext">ready</span></div>
  </header>
  <main id="chat"></main>
  <footer>
    <div class="actions"><button id="continue"><span>Continue</span><span class="badge" id="badge"></span></button></div>
    <div class="quotechip" id="quotechip" hidden>
      <span class="quotechip-text" id="quotechiptext"></span>
      <button id="quotechippop" title="remove quote">×</button>
    </div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="Type a message…"></textarea>
      <button id="send">Send</button>
    </div>
    <div class="hint">Enter sends · empty Enter continues · hover a paragraph to reply to it · “yeah / ok / lol” continue without restarting</div>
  </footer>
</div>
<script>
(function () {
  'use strict';
  var chat = document.getElementById('chat');
  var dot = document.getElementById('dot');
  var statustext = document.getElementById('statustext');
  var contBtn = document.getElementById('continue');
  var badge = document.getElementById('badge');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var quotechip = document.getElementById('quotechip');
  var quotechiptext = document.getElementById('quotechiptext');
  var quotechippop = document.getElementById('quotechippop');

  var state = {
    turnId: null,
    visible: [],
    buffered: 0,
    revealed: 0,
    pending: false,
    busy: false,
    timer: null,
    streaming: false,
    bubble: null,
    caret: null,
    quote: null,
    live: { text: '', el: null, final: true, renderQueued: false },
    play: { el: null, full: '', chars: 0, step: 1, timer: null, tps: null, active: false },
    stream: { id: null, ctrl: null, retry: null, done: true },
  };

  function md(s) {
    var h = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    var blocks = [];
    h = h.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function (m, c) {
      blocks.push('<pre><code>' + c.replace(/\\n$/, '') + '</code></pre>');
      return '\\u0001' + (blocks.length - 1) + '\\u0001';
    });
    h = h.replace(/^###\\s+(.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^##\\s+(.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/^#\\s+(.+)$/gm, '<h1>$1</h1>');
    h = h.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    h = h.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
    h = h.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
    h = h.replace(/~{2}([^~\\n]+)~{2}/g, '<del>$1</del>');
    h = h.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    var out = [], list = null;
    h.split('\\n').forEach(function (ln) {
      var li = ln.match(/^\\s*[-*+]\\s+(.*)$/);
      if (li) {
        if (list !== 'ul') { if (list) out.push('</' + list + '>'); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + li[1] + '</li>');
        return;
      }
      var oli = ln.match(/^\\s*\\d+\\.\\s+(.*)$/);
      if (oli) {
        if (list !== 'ol') { if (list) out.push('</' + list + '>'); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + oli[1] + '</li>');
        return;
      }
      if (list) { out.push('</' + list + '>'); list = null; }
      out.push(ln);
    });
    if (list) out.push('</' + list + '>');
    h = out.join('\\n');
    h = h.replace(/\\u0001(\\d+)\\u0001/g, function (m, i) { return blocks[+i]; });
    return h;
  }

  function scrollDown() { chat.scrollTop = chat.scrollHeight; }

  function setStatus(text, live) {
    statustext.textContent = text;
    dot.className = 'dot' + (live ? ' live' : '');
  }

  function ensureBubble() {
    if (!state.bubble) {
      state.bubble = document.createElement('div');
      state.bubble.className = 'msg assistant';
      chat.appendChild(state.bubble);
    }
    return state.bubble;
  }

  function addReply(el, idx, raw) {
    var rb = document.createElement('button');
    rb.className = 'replybtn';
    rb.type = 'button';
    rb.textContent = 'reply';
    rb.addEventListener('click', function () {
      setQuote(state.turnId, idx, raw);
    });
    el.appendChild(rb);
  }

  function syncCaret() {
    var host = null;
    if (state.live.el && !state.live.final) host = state.live.el;
    else if (state.play.active && state.play.el) host = state.play.el;
    if (host) {
      if (!state.caret) state.caret = document.createElement('span');
      state.caret.className = 'caret';
      if (state.caret.parentNode !== host) host.appendChild(state.caret);
    } else if (state.caret && state.caret.parentNode) {
      state.caret.parentNode.removeChild(state.caret);
    }
  }

  function renderLive() {
    if (state.live.renderQueued || state.live.final || !state.live.el) return;
    state.live.renderQueued = true;
    requestAnimationFrame(function () {
      state.live.renderQueued = false;
      if (state.live.el && !state.live.final) {
        state.live.el.innerHTML = md(state.live.text);
        syncCaret();
        scrollDown();
      }
    });
  }

  function finalizeLive() {
    if (!state.live.el || state.live.final) return;
    state.live.final = true;
    var el = state.live.el;
    var text = state.live.text;
    state.live.el = null;
    state.live.renderQueued = false;
    el.classList.remove('live');
    el.innerHTML = md(text);
    addReply(el, state.revealed, text);
    state.visible.push({ role: 'assistant', content: text });
    state.revealed++;
    syncCaret();
    showContinue();
    updateStatus();
    scrollDown();
  }

  function playNext() {
    if (state.play.active || state.live.el || state.busy || !state.turnId) return;
    if (state.buffered < 1) { state.pending = true; return; }
    state.busy = true;
    fetch('/api/turns/' + state.turnId + '/reveal', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.busy = false;
        if (d.error) { setStatus('error: ' + d.error); return; }
        if (!d.content) { state.pending = false; return; }
        state.buffered--;
        var el = document.createElement('div');
        el.className = 'chunk playing';
        el.dataset.idx = state.revealed;
        el.title = 'click to finish';
        el.addEventListener('click', finishPlay);
        ensureBubble().appendChild(el);
        var chars = d.content.length;
        var rate = (state.play.tps || 20) * 4; // chars/sec ~= tps * 4 chars per token
        var dur = Math.min(12, Math.max(0.6, chars / Math.max(rate, 4)));
        var step = Math.max(1, Math.round(chars / (dur * 15)));
        state.play.el = el;
        state.play.full = d.content;
        state.play.chars = 0;
        state.play.step = step;
        state.play.active = true;
        playTick();
      })
      .catch(function (e) { state.busy = false; setStatus('reveal failed: ' + e); });
  }

  function playTick() {
    if (!state.play.active) return;
    var p = state.play;
    p.chars = Math.min(p.full.length, p.chars + p.step);
    p.el.innerHTML = md(p.full.slice(0, p.chars));
    syncCaret();
    if (p.chars >= p.full.length) { finishPlay(); return; }
    p.timer = setTimeout(playTick, 66);
  }

  function finishPlay() {
    var p = state.play;
    if (!p.active) return;
    clearTimeout(p.timer);
    p.active = false;
    var el = p.el;
    var full = p.full;
    var idx = Number(el.dataset.idx);
    p.el = null;
    p.full = '';
    p.chars = 0;
    p.step = 1;
    el.classList.remove('playing');
    el.innerHTML = md(full);
    addReply(el, idx, full);
    state.visible.push({ role: 'assistant', content: full });
    state.revealed++;
    syncCaret();
    showContinue();
    updateStatus();
    scrollDown();
    maybeAuto();
  }

  function maybeAuto() {
    if (!state.pending) return;
    if (state.play.active || state.live.el) return;
    if (state.buffered > 0) {
      state.pending = false;
      playNext();
    }
  }

  function showContinue() {
    var n = state.buffered;
    var show = state.streaming || n > 0;
    contBtn.className = show ? 'on' : '';
    contBtn.disabled = !(n > 0);
    badge.style.display = n > 0 ? '' : 'none';
    badge.textContent = n > 0 ? String(n) : '…';
  }

  function updateStatus() {
    if (state.streaming) return;
    if (state.buffered > 0) setStatus('draft ready · ' + state.buffered + ' buffered');
    else if (state.turnId) setStatus('complete');
  }

  // ---------- SSE consumption: fetch + ReadableStream (not EventSource) ----------

  function closeStream() {
    clearTimeout(state.stream.retry);
    state.stream.retry = null;
    if (state.stream.ctrl) {
      try { state.stream.ctrl.abort(); } catch {}
      state.stream.ctrl = null;
    }
    state.stream.done = true;
  }

  function ensureLiveEl() {
    if (!state.live.el) {
      state.live.el = document.createElement('div');
      state.live.el.className = 'chunk live';
      ensureBubble().appendChild(state.live.el);
    }
  }

  function handleFrame(payload) {
    if (!payload) return;
    var d;
    try { d = JSON.parse(payload); } catch { return; }
    if (state.turnId !== state.stream.id) return;
    if (d.type === 'initial') {
      ensureLiveEl();
      state.live.final = false;
      state.live.text = d.t;
      renderLive();
    } else if (d.type === 'delta') {
      ensureLiveEl();
      state.live.final = false;
      state.live.text += d.t;
      renderLive();
    } else if (d.type === 'end') {
      state.play.tps = d.tps || null;
      finalizeLive();
    } else if (d.type === 'buffered') {
      state.buffered = d.n;
      showContinue();
      maybeAuto();
    } else if (d.type === 'status') {
      if (d.status === 'done') {
        state.streaming = false;
        stopPolling();
        if (typeof d.buffered === 'number') state.buffered = d.buffered;
        setStatus(state.buffered ? 'draft ready · ' + state.buffered + ' buffered' : 'complete');
        closeStream();
      } else if (d.status === 'error') {
        state.streaming = false;
        stopPolling();
        setStatus('error: ' + (d.error || 'generation failed'));
        closeStream();
      } else if (d.status === 'superseded') {
        state.streaming = false;
        setStatus('superseded — draft discarded');
        closeStream();
      }
      syncCaret();
      showContinue();
      maybeAuto();
    }
  }

  function openStream(id) {
    closeStream();
    state.stream.id = id;
    state.stream.done = false;
    var ctrl = new AbortController();
    state.stream.ctrl = ctrl;
    fetch('/api/turns/' + id + '/stream', { signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok || !r.body) throw new Error('stream http ' + r.status);
        var reader = r.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += dec.decode(res.value, { stream: true });
            var nl;
            while ((nl = buf.indexOf('\\n')) !== -1) {
              var line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (line.indexOf('data:') === 0) handleFrame(line.slice(5).trim());
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        if (state.stream.done) return; // closed on purpose
        state.stream.retry = setTimeout(function () { openStream(id); }, 1200);
      });
  }

  function poll() {
    if (!state.turnId) return;
    fetch('/api/turns/' + state.turnId)
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (state.timer === null && !s.ended) startPolling();
        state.buffered = s.buffered;
        if (s.status === 'streaming') {
          state.streaming = true;
          setStatus('generating' + (s.buffered ? ' · ' + s.buffered + ' buffered' : '') + '…', true);
        } else {
          state.streaming = false;
          stopPolling();
          if (s.status === 'done') setStatus(s.buffered ? 'draft ready · ' + s.buffered + ' buffered' : (s.total ? 'complete' : 'no output'));
          else if (s.status === 'superseded') setStatus('superseded — draft discarded');
          else setStatus(s.error ? 'error: ' + s.error : 'error');
        }
        syncCaret();
        showContinue();
        maybeAuto();
      })
      .catch(function () {});
  }

  function startPolling() { if (!state.timer) state.timer = setInterval(poll, 400); }
  function stopPolling() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  function setQuote(turnId, chunkIdx, text) {
    state.quote = { turnId: turnId, chunkIdx: chunkIdx, text: text };
    quotechiptext.textContent = text.length > 140 ? text.slice(0, 140) + '…' : text;
    quotechip.hidden = false;
    input.focus();
  }

  quotechippop.addEventListener('click', function () {
    state.quote = null;
    quotechip.hidden = true;
    input.focus();
  });

  function addUser(text, quote) {
    var el = document.createElement('div');
    el.className = 'msg user';
    if (quote) {
      var q = document.createElement('div');
      q.className = 'quote-block';
      q.textContent = '↩ ' + quote.text;
      el.appendChild(q);
    }
    var body = document.createElement('div');
    body.innerHTML = md(text);
    el.appendChild(body);
    chat.appendChild(el);
    scrollDown();
  }

  function addAck(text) {
    var el = document.createElement('div');
    el.className = 'msg ack';
    el.textContent = text;
    chat.appendChild(el);
    scrollDown();
  }

  function doContinue() {
    if (state.live.el || state.play.active) { state.pending = true; return; }
    if (state.buffered > 0) playNext();
    else if (state.streaming) state.pending = true;
  }

  function sendText(text) {
    var myQuote = state.quote;
    state.quote = null;
    quotechip.hidden = true;
    fetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        turnId: state.turnId,
        history: state.visible,
        text: text,
        quote: myQuote ? { turnId: myQuote.turnId, chunkIdx: myQuote.chunkIdx } : null,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { setStatus('error: ' + d.error); return; }
        if (d.kind === 'ack') {
          addAck(text);
          if (state.buffered > 0 && !state.live.el && !state.play.active) playNext();
          else state.pending = true;
          return;
        }
        if (state.turnId !== d.turnId) {
          if (state.play.active) finishPlay();
          clearTimeout(state.play.timer);
          closeStream();
          state.turnId = d.turnId;
          state.streaming = true;
          state.bubble = null;
          state.pending = false;
          state.revealed = 0;
          state.buffered = 0;
          state.live = { text: '', el: null, final: true, renderQueued: false };
          state.play.tps = null;
          state.play.active = false;
          syncCaret();
          startPolling();
          openStream(d.turnId);
        }
        addUser(d.content || text, myQuote);
        state.visible.push({ role: 'user', content: d.content || text });
      })
      .catch(function (e) { setStatus('request failed: ' + e); });
  }

  contBtn.addEventListener('click', doContinue);
  sendBtn.addEventListener('click', function () {
    var t = input.value.trim();
    if (t) { input.value = ''; input.style.height = 'auto'; sendText(t); }
    else doContinue();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var t = input.value.trim();
      if (t) { input.value = ''; input.style.height = 'auto'; sendText(t); }
      else doContinue();
    }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  input.focus();
})();
</script>
</body>
</html>
`;