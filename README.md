# stream-talker

Incremental text chat with **speculative continuation**: the model keeps generating
while you read. The first paragraph streams into your chat live as its tokens
arrive; everything after it is buffered in secret. Each next paragraph is played
back when you continue, at roughly the pace it was generated, and unseen draft
text never enters the next inference.

Zero dependencies. Requires Node >= 18. The server is intentionally small; the
single-page client lives in `app/index.html` so the v1 interaction can evolve
without maintaining a second embedded copy.

```sh
OPENAI_API_KEY=sk-... node server.js                          # defaults
node server.js -m gpt-4o-mini -b https://api.openai.com/v1 -k OPENAI_API_KEY
node server.js -b http://localhost:11434/v1 -m llama3.1       # ollama (OpenAI-compat)
node server.js -b http://localhost:1234/v1 -m my-model        # llama.cpp / LM Studio

# Gemini's OpenAI-compatible endpoint
node server.js -m <gemini-model-id> \
  -b https://generativelanguage.googleapis.com/v1beta/openai \
  -k GEMINI_API_KEY
```

The key is read from the environment variable named by `-k`; it is never
stored in the project. Keep local `.env` files and provider credentials out of
Git.

Open `http://localhost:8787` (`-p <port>` to change).

For a local mock-only walkthrough, open `app/index.html` directly or add
`?demo` to the URL. The real server page uses the configured model endpoint.

The two companion experiments are available at `/annotation` (full answer with
multi-selection annotations) and `/mixed` (speculative continuation plus
annotations on the visible frontier).

Each page has an optional **guided** toggle. Off is a normal chat completion
with heuristic paragraph chunking; on adds a small cohesion prompt and folds
short transition paragraphs into the section that follows them.

- **Enter** with text sends; empty **Enter** (or the Continue button) plays the
  next buffered paragraph at the measured generation pace (click it to finish
  instantly).
- The first paragraph streams in live the moment its tokens arrive.
- Acks like `yeah`, `ok`, `lol`, `I see` keep an active turn alive without
  restarting inference. After a completion, even a short reaction starts a new
  turn.
- Anything else supersedes the draft and starts fresh — only revealed text +
  microturns go into context.

See `node server.js --help` for all options.
