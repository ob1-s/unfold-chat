# stream-talker

Incremental text chat with **speculative continuation**: the model keeps generating
while you read; each paragraph is revealed only when you continue, and unseen
draft text never enters the next inference.

One file, zero dependencies. Requires Node >= 18.

```sh
OPENAI_API_KEY=sk-... node server.js                          # defaults
node server.js -m gpt-4o-mini -b https://api.openai.com/v1 -k OPENAI_API_KEY
node server.js -b http://localhost:11434/v1 -m llama3.1       # ollama (OpenAI-compat)
node server.js -b http://localhost:1234/v1 -m my-model        # llama.cpp / LM Studio
```

Open `http://localhost:8787` (`-p <port>` to change).

- **Enter** with text sends; **empty Enter** (or the Continue button) reveals the
  next buffered paragraph.
- Acks like `yeah`, `ok`, `lol`, `I see` are recorded and never restart inference.
- Anything else supersedes the draft and starts fresh — only revealed text +
  microturns go into context.

See `node server.js --help` for all options.