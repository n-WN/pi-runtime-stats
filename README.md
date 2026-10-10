# pi-runtime-stats

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Timing and cache telemetry for [pi](https://github.com/earendil-works/pi), in the
footer and in the working row. No emoji, every value labelled, nothing that pi's
own footer already shows.

```text
turn 4.2s  step 3 │ call 8.4k→118  prefill 3.8s  decode 118t/s │ session 12m03s  busy 68%  turns 7  hit 74.8%
```

The line has three groups: the current prompt (turn), the latest LLM call, and
the session. Some fields appear only when they say something: `via` once a
session has used more than one upstream, `retry` when a gateway needed more than
one attempt, `errors` when a call failed.

While a request is in flight the `Working…` row becomes a live timer:

```text
waiting 12.4s (no first token)
streaming 45.2s · first token 3.8s
```

## Install

```bash
pi install npm:pi-runtime-stats
```

or from source:

```bash
pi install https://github.com/n-WN/pi-runtime-stats
```

Restart pi. There is nothing to configure.

## What each field means

| Field | Group | Meaning |
|---|---|---|
| `turn` | turn | wall time of the current prompt, live while running |
| `step` | turn | LLM round-trips inside this turn |
| `call` | call | prompt tokens → output tokens of the latest LLM call |
| `prefill` | call | dispatch → first streamed token (TTFT) |
| `decode` | call | output rate over the streaming window |
| `via` | call | upstream that served the call behind an Anthropic-compatible gateway: `bedrock`, `vertex` or `anthropic`, from the message id. Shown once the session has seen more than one |
| `retry` | call | attempts the gateway needed beyond the first ([GPT-Load](https://github.com/tbphp/gpt-load)'s `x-gptload-attempts` header) |
| `session` | session | wall time since the session started |
| `busy` | session | share of session time the agent was actually working |
| `turns` | session | completed turns |
| `hit` | session | prompt-cache hit rate across the **whole** session |
| `errors` | session | LLM calls that failed |

pi's own footer shows the latest call's cache hit rate (`CH`) and the session
token totals, so this line does not repeat them. `hit` is the cumulative ratio:
early in a session it is much lower than `CH`, because the first calls are all
cache writes. A failed call counts only in `errors`; the call group keeps the
figures of the last call that worked.

`busy` separates "the model is slow" from "I was reading the diff": it counts
only `agent_start` → `agent_settled` intervals.

## Three levels, and a naming trap

pi's event model has three nested scopes, and its own naming is easy to
misread:

| Level | Events | Meaning |
|---|---|---|
| Session | `session_start` → `session_shutdown` | the whole session |
| **Turn** | `agent_start` → `agent_settled` | one prompt, start to finish |
| **Step** | `turn_start` → `turn_end` | a single LLM response + tool calls |

pi calls the innermost unit a *turn*. This extension labels it `step`, so that a
prompt that made five tool calls shows `turn 42s  step 5` instead of resetting a
"turn" timer five times.

The turn timer stops on `agent_settled`, not `agent_end`: pi may auto-retry or
auto-compact-and-continue after `agent_end`, and stopping there would report
completion while the agent is still working.

## Buffered (non-streaming) backends

Some Anthropic-compatible endpoints generate the full completion and only then
emit every SSE event at once. First and last token arrive together, the decode
window collapses to near zero, and tokens/second computed from it would be
nonsense — a 1,800-character response "generated" in 30 ms.

Those responses are detected and reported as shown below. A response counts as
buffered when its decode window is under 5% of the total response time **and** the
implied rate is above 2,000 tokens/s. The rate check matters: after a long
time-to-first-token (for example a cold prefill on a self-hosted server) a normal
stream also has a small decode share, but it decodes at a plausible rate.

```text
decode n/a(bulk)
```

`prefill` still shows a real number in that case, but be aware it then equals
end-to-end latency rather than true prefill, since nothing streamed early.

## Notes

- The session clock also resets on `session_before_switch` / `session_before_fork`,
  so resuming an old session does not report its original age.
- All rendering is wrapped in try/catch; a telemetry failure never breaks a request.
- Updates at 4 Hz while the agent works. While idle it re-checks every 15 s and
  re-sends the footer only when its text changes; the `session` clock shows whole
  minutes while idle. Every footer update makes pi re-render its TUI, and that cost
  grows with the transcript, so an idle pi with a long session now stays near 0% CPU
  instead of re-rendering four times a second.

## License

MIT
