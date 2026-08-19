# unfold-chat

As frontier models get better, I find myself caring more about what they say.
It is not rare for almost an entire answer to be interesting, raise follow-ups,
or contain something I want to push back on.

The problem is not that I need to answer before the model finishes. Usually the
model writes quickly, and the answer is effectively locked while it is being
generated anyway. The friction starts as I try to read that wall and respond to
it as a normal conversation.

I see the wall of text being built, then I have to start at the top and process
the whole thing as one singleton message. When something is interesting, I copy
that passage into the input, add my commentary, add some new line breaks without
sending, and continue reading. I keep doing that until I have worked through the
entire long-ass message. Then I send it—and the cycle repeats as the model
writes another long-ass wall of text. Hahahaha.

Unfold is a small interaction experiment around that friction. It treats the
model's user-facing answer less like one monolithic object and more like
something I can read and interact with as it unfolds:

- The first section streams live as it is generated.
- The next sections keep generating, but stay out of sight until I ask for them.
- **Continue** reveals the next section at roughly its natural generation pace.
- If the model is already writing that section, Continue catches me up to the
  current point and then hands control back to the live stream.
- While a turn is active, a short acknowledgement keeps it alive. A real
  correction or interruption discards the unseen draft and starts fresh from
  only what I have actually seen. Once generation is complete, even a short
  reaction starts a new turn.

The point is not to make AI talk more, or to pretend I need to answer while it is
still generating. It is to stop treating everything the model says out loud as
one giant indivisible event. I want to read what it is saying, notice the parts
that matter, and interact with those parts in a more natural way.

The word I keep coming back to is **ergonomics**. A model can be brilliant, but
if its answer is tiring to read or impossible to course-correct, the interaction
still feels bad.

That sounds like a small UI change, but it changes the feeling from “here is a
wall of text; good luck” to “here is the next bit—want to keep going?” hahaha.

## The three experiments

The root page (`/`) is the original speculative-continuation version.

- `/` — speculative continuation. The first paragraph is live; later paragraphs
  are buffered until Continue or an empty Enter.
- `/annotation` — the complete answer is visible. Select passages, attach
  multiple notes, and respond to the annotations instead of copy-pasting quotes
  into the composer.
- `/mixed` — speculative continuation plus annotations on the visible frontier.

The three pages share the same chat rail, composer, scrollbar behavior, and
response rendering. They are meant to make the interaction easy to compare,
not to pretend that one design has already won.

## A deliberate constraint

By default, the request is as close as possible to a normal chat completion:
there is no custom system prompt telling the model how to behave. The server
uses a small paragraph-boundary heuristic to decide what can be revealed.

Each page also has an optional **guided** toggle. Guided mode adds one small
cohesion instruction and folds short transition sentences into the section they
introduce. It is there as an experiment, not as a hidden requirement for the
interaction to work.

The important context rule is simple: unseen speculative text never gets sent
back into a fresh inference. When I respond to the answer, the new turn only
sees the conversation and response text that actually reached me.

There is an honest tradeoff here: the model may generate text I never ask to
see, and those tokens are wasted if I interrupt. That cost is part of the
experiment. The question is whether the improved reading and steering
experience is worth it.

## Run it

Zero dependencies. Requires Node >= 18.

```sh
# OpenAI-compatible default
OPENAI_API_KEY=your-key-here node server.js

# Any OpenAI-compatible endpoint
node server.js -m my-model -b https://example.com/v1 -k MY_API_KEY

# Ollama
node server.js -b http://localhost:11434/v1 -m llama3.1

# llama.cpp / LM Studio
node server.js -b http://localhost:1234/v1 -m my-model

# Gemini's OpenAI-compatible endpoint
node server.js -m <gemini-model-id> \
  -b https://generativelanguage.googleapis.com/v1beta/openai \
  -k GEMINI_API_KEY
```

The key is read from the environment variable named by `-k`; it is never stored
in the project. Keep local `.env` files and provider credentials out of Git.

Open `http://localhost:8787` (`-p <port>` to change). The server appends
`/chat/completions` to the configured base URL.

For a local mock-only walkthrough, open `app/index.html` directly or add
`?demo` to the URL. The mock lets me explore the interaction without spending
tokens or configuring a provider.

See `node server.js --help` for all options.

## What this is

This is intentionally a small prototype / interaction lab, not a claim that
the final chat interface has been invented. The interesting question is whether
frontier-model answers become easier to read when the reader can control how
the answer is revealed and respond to individual passages as they encounter
them, instead of receiving one completed wall and reconstructing a conversation
around it manually.

The server is kept small and the client lives in `app/` so the interaction can
evolve without maintaining a second embedded copy. This is mainly about the
user-facing answer—the part I actually have to read—not a claim that a UI layer
can control every hidden model or tool step behind it.
