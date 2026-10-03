# pi-runtime-stats

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Timing and cache telemetry for [pi](https://github.com/earendil-works/pi), in the
footer and in the working row. No emoji, every value labelled.

```text
turn 4.2s  step 3  prefill 3.8s  decode 118t/s  cache 99.8%  avg 74.8%  session 12m03s  busy 68%  turns 7
```

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

| Field | Scope | Meaning |
|---|---|---|
| `turn` | turn | wall time of the current prompt, live while running |
| `step` | turn | LLM round-trips inside this turn |
| `prefill` | request | dispatch → first streamed token (TTFT) |
| `decode` | request | output rate over the streaming window |
| `cache` | request | prompt-cache hit rate of the **latest** LLM call |
| `avg` | session | prompt-cache hit rate across the **whole** session |
| `session` | session | wall time since the session started |
| `busy` | session | share of session time the agent was actually working |
| `turns` | session | completed turns |

`cache` reproduces pi's built-in `CH` indicator, which only reflects the most
recent assistant message. `avg` is the cumulative ratio — early in a session the
two differ a lot, because the first calls are all cache writes.

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

Those responses are detected (decode window under 5% of total response time) and
reported as:

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
