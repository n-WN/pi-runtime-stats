/**
 * pi-runtime-stats
 *
 * Adds timing and cache telemetry to pi's footer, and turns the "Working…"
 * row into a live per-request timer.
 *
 * Footer, one line in three groups:
 *
 *   turn 4.2s  step 3 │ call 8.4k→120  prefill 3.8s  decode 120t/s  via bedrock  retry 1 │ session 12m03s  busy 68%  turns 7  hit 74.8%  errors 2
 *
 *   turn      wall time of the current prompt (agent_start → agent_settled)
 *   step      LLM round-trips inside that turn
 *   call      prompt tokens → output tokens of the latest LLM call
 *   prefill   dispatch → first streamed token (TTFT)
 *   decode    output rate measured over the streaming window
 *   via       upstream behind an Anthropic-compatible gateway (Bedrock, Vertex or the
 *             Anthropic API, from the message id), once a session has seen more than one
 *   retry     attempts the gateway needed before the call succeeded, when it says so
 *             (GPT-Load's x-gptload-attempts header)
 *   session   wall time since the session started (minutes while idle)
 *   busy      share of session time the agent was actually working
 *   turns     completed turns
 *   hit       prompt-cache hit rate across the whole session
 *   errors    LLM calls that failed in this session
 *
 * pi's own footer already shows the latest call's cache hit rate (CH) and the
 * session token totals; this line does not repeat them.
 *
 * Working row:
 *   waiting 12.4s (no first token)
 *   streaming 45.2s · first token 3.8s
 *
 * Terminology, per pi's own event model (docs/extensions.md):
 *   Session  session_start → session_shutdown
 *   Turn     agent_start   → agent_settled     one prompt, start to finish
 *   Step     turn_start    → turn_end          a single LLM response + tool calls
 * Note pi names the innermost unit "turn"; this extension labels it "step" so
 * the three levels stay distinguishable in a one-line footer.
 *
 * Non-streaming backends: some Anthropic-compatible endpoints buffer the whole
 * completion and then emit every SSE event at once. First and last token then
 * arrive together, the decode window collapses to ~0, and a tokens/second
 * figure computed from it would be meaningless. Those responses are detected
 * and reported as `decode n/a(bulk)` instead of an invented number.
 *
 * Cost: every ctx.ui.setStatus() call makes pi re-render the whole TUI, and the
 * render cost grows with the transcript. So the footer is re-sent only when its
 * text changes, the 4 Hz ticker runs only while the agent works, and the idle
 * footer uses minute precision so that it changes at most once a minute.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "runtime-stats";
const TICK_MS = 250;
/** Idle cadence. The idle footer only changes once a minute, see durMinutes(). */
const IDLE_TICK_MS = 15_000;
/** Decode window shorter than this fraction of the response ⇒ possibly buffered… */
const BULK_RATIO = 0.05;
/** …and only if the implied rate is also impossible for one streamed response. */
const BULK_MIN_RATE = 2000; // tokens/s

type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export default function (pi: ExtensionAPI) {
  // Session scope
  let sessionStart = Date.now();
  let busyMs = 0;
  let turnCount = 0;

  // Turn scope
  let turnStart: number | undefined; // undefined ⇒ idle
  let lastTurnMs: number | undefined;
  let stepInTurn = 0;

  // Per-LLM-call scope
  let dispatchAt: number | undefined;
  let firstTokenAt: number | undefined;
  let lastPrefillMs: number | undefined;
  let lastDecodeMs: number | undefined;
  let lastOutputTokens: number | undefined;
  let lastWasBulk = false;
  let lastPromptTokens: number | undefined;
  let lastBackend: string | undefined;
  let lastAttempts: number | undefined;
  /** Gateway attempts reported in the response headers of the call in flight. */
  let pendingAttempts: number | undefined;
  /** Upstreams seen in this session; `via` shows only when there is more than one. */
  const backendsSeen = new Set<string>();
  let errorCount = 0;

  let ticker: ReturnType<typeof setInterval> | undefined;
  let tickerMs: number | undefined;
  /** Last status text sent to pi. Every setStatus() call makes pi re-render the TUI. */
  let lastStatus: string | undefined;

  // Incremental cache totals. Session entries are append-only within one session.
  let scanned = 0;
  let lastScannedEntry: unknown;
  let sumInput = 0;
  let sumRead = 0;
  let sumWrite = 0;

  /** Prompt-cache hit rate across the session, from the usage of every session entry. */
  function sessionHitRate(ctx: ExtensionContext): number | undefined {
    try {
      const entries = ctx.sessionManager.getEntries() as any[];
      // Rescan from the start when the entry list is not an extension of the last scan
      // (session switch, fork, tree navigation).
      if (scanned > entries.length || (scanned > 0 && entries[scanned - 1] !== lastScannedEntry)) {
        scanned = 0;
        sumInput = 0;
        sumRead = 0;
        sumWrite = 0;
      }
      for (; scanned < entries.length; scanned++) {
        const entry = entries[scanned];
        const u: Usage | undefined =
          entry?.type === "message"
            ? entry.message?.usage
            : entry?.type === "branch_summary" || entry?.type === "compaction"
              ? entry.usage
              : undefined;
        if (!u) continue;

        sumInput += u.input ?? 0;
        sumRead += u.cacheRead ?? 0;
        sumWrite += u.cacheWrite ?? 0;
      }
      lastScannedEntry = entries[scanned - 1];
    } catch {
      return undefined;
    }
    const prompt = sumInput + sumRead + sumWrite;
    return prompt > 0 ? (sumRead / prompt) * 100 : undefined;
  }

  /** Live per-request timer in the "Working…" row. */
  function renderWorking(ctx: ExtensionContext) {
    try {
      if (dispatchAt === undefined) return;
      const waited = dur(Date.now() - dispatchAt);
      if (firstTokenAt === undefined) {
        ctx.ui.setWorkingMessage(`waiting ${waited} (no first token)`);
      } else {
        ctx.ui.setWorkingMessage(
          `streaming ${waited} · first token ${dur(firstTokenAt - dispatchAt)}`,
        );
      }
    } catch {
      /* ignore */
    }
  }

  function render(ctx: ExtensionContext) {
    renderWorking(ctx);
    try {
      const t = ctx.ui.theme;
      const kv = (label: string, value: string, hot = false) =>
        t.fg("muted", `${label} `) + t.fg(hot ? "accent" : "dim", value);

      const turn: string[] = [];
      if (turnStart !== undefined) {
        turn.push(kv("turn", dur(Date.now() - turnStart), true));
        if (stepInTurn > 0) turn.push(kv("step", String(stepInTurn), true));
      } else if (lastTurnMs !== undefined) {
        turn.push(kv("turn", dur(lastTurnMs)));
        if (stepInTurn > 0) turn.push(kv("step", String(stepInTurn)));
      }

      const call: string[] = [];
      if (lastPromptTokens !== undefined && lastOutputTokens !== undefined) {
        call.push(kv("call", `${tokens(lastPromptTokens)}→${tokens(lastOutputTokens)}`));
      }
      if (lastPrefillMs !== undefined) call.push(kv("prefill", dur(lastPrefillMs)));
      if (lastDecodeMs !== undefined) {
        if (lastWasBulk) {
          call.push(kv("decode", "n/a(bulk)"));
        } else if (lastOutputTokens && lastDecodeMs > 0) {
          const tps = lastOutputTokens / (lastDecodeMs / 1000);
          call.push(kv("decode", `${tps.toFixed(0)}t/s`));
        }
      }
      if (lastBackend && backendsSeen.size > 1) call.push(kv("via", lastBackend));
      if (lastAttempts !== undefined && lastAttempts > 1) call.push(kv("retry", String(lastAttempts - 1)));

      const session: string[] = [];
      const elapsed = Date.now() - sessionStart;
      session.push(kv("session", isBusy() ? dur(elapsed) : durMinutes(elapsed)));
      const liveBusy = busyMs + (turnStart !== undefined ? Date.now() - turnStart : 0);
      if (elapsed > 0 && liveBusy > 0) {
        session.push(kv("busy", `${Math.min(100, (liveBusy / elapsed) * 100).toFixed(0)}%`));
      }
      if (turnCount > 0) session.push(kv("turns", String(turnCount)));
      const hit = sessionHitRate(ctx);
      if (hit !== undefined) session.push(kv("hit", `${hit.toFixed(1)}%`));
      if (errorCount > 0) session.push(t.fg("muted", "errors ") + t.fg("warning", String(errorCount)));

      const status = [turn, call, session]
        .filter((group) => group.length > 0)
        .map((group) => group.join(t.fg("muted", "  ")))
        .join(t.fg("dim", " │ "));
      if (status !== lastStatus) {
        lastStatus = status;
        ctx.ui.setStatus(STATUS_KEY, status);
      }
    } catch {
      /* never break the session over a status line */
    }
  }

  /** (Re)start the ticker; optionally reset all counters. Idempotent. */
  function arm(ctx: ExtensionContext, resetClock: boolean) {
    if (resetClock) {
      lastStatus = undefined; // pi may have cleared the status line
      sessionStart = Date.now();
      busyMs = 0;
      turnCount = 0;
      turnStart = undefined;
      lastTurnMs = undefined;
      stepInTurn = 0;
      dispatchAt = undefined;
      firstTokenAt = undefined;
      lastPrefillMs = undefined;
      lastDecodeMs = undefined;
      lastOutputTokens = undefined;
      lastWasBulk = false;
      lastPromptTokens = undefined;
      lastBackend = undefined;
      lastAttempts = undefined;
      pendingAttempts = undefined;
      backendsSeen.clear();
      errorCount = 0;
    }
    schedule(ctx);
    render(ctx);
  }

  function isBusy(): boolean {
    return turnStart !== undefined || dispatchAt !== undefined;
  }

  /** Fast ticks only while the agent works; slow ticks while idle. Idempotent. */
  function schedule(ctx: ExtensionContext) {
    const want = isBusy() ? TICK_MS : IDLE_TICK_MS;
    if (ticker && tickerMs === want) return;
    if (ticker) clearInterval(ticker);
    tickerMs = want;
    ticker = setInterval(() => render(ctx), want);
  }

  pi.on("session_start", async (_e, ctx) => arm(ctx, true));
  // pi 1.x gives /new, /resume and /fork a new extension runtime: session_start (with its reason)
  // arms the new one and session_shutdown stops the old one. Arming on session_before_switch or
  // session_before_fork reset the counters too early: another extension can cancel those.

  pi.on("agent_start", async (_e, ctx) => {
    turnStart = Date.now();
    stepInTurn = 0;
    schedule(ctx);
    render(ctx);
  });

  pi.on("before_provider_request", async (_e, ctx) => {
    dispatchAt = Date.now();
    firstTokenAt = undefined;
    schedule(ctx); // keep the working row ticking
    renderWorking(ctx);
  });

  pi.on("after_provider_response", async (event) => {
    const attempts = Number(headerValue(event.headers, "x-gptload-attempts"));
    pendingAttempts = Number.isFinite(attempts) && attempts > 0 ? attempts : undefined;
  });

  pi.on("message_update", async (_e, ctx) => {
    if (dispatchAt !== undefined && firstTokenAt === undefined) {
      firstTokenAt = Date.now();
      lastPrefillMs = firstTokenAt - dispatchAt;
      renderWorking(ctx);
    }
  });

  pi.on("message_end", async (event: any, ctx) => {
    const message = event?.message;
    if (message?.role !== "assistant") return;
    // A failed call only counts as an error: its round-trip is no prefill, and it
    // keeps the figures of the last call that worked. pi 1.x ends a call that Esc
    // stops with stopReason "error" too; that is the user, so it is not counted.
    if (message.stopReason === "error") {
      if (!ctx.signal?.aborted) errorCount++;
    } else {
      const end = Date.now();
      if (dispatchAt !== undefined) {
        const total = end - dispatchAt;
        if (firstTokenAt !== undefined) {
          lastPrefillMs = firstTokenAt - dispatchAt;
          lastDecodeMs = end - firstTokenAt;
        } else {
          lastPrefillMs = total;
          lastDecodeMs = 0;
        }
        lastOutputTokens = message.usage?.output;
        lastWasBulk = isBulk(total, lastDecodeMs, lastOutputTokens);
      }
      const u: Usage | undefined = message.usage;
      if (u) lastPromptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      lastBackend = backendOf(message.responseId);
      if (lastBackend) backendsSeen.add(lastBackend);
      lastAttempts = pendingAttempts;
    }
    pendingAttempts = undefined;
    dispatchAt = undefined;
    firstTokenAt = undefined;
    try {
      ctx.ui.setWorkingMessage();
    } catch {
      /* ignore */
    }
    render(ctx);
  });

  pi.on("turn_end", async (_e, ctx) => {
    stepInTurn++;
    schedule(ctx);
    render(ctx);
  });

  pi.on("agent_end", async (_e, ctx) => {
    if (turnStart !== undefined) lastTurnMs = Date.now() - turnStart;
    render(ctx);
  });

  // agent_end can be followed by auto-retry or auto-compact-and-continue,
  // so the turn is only really over at agent_settled.
  pi.on("agent_settled", async (_e, ctx) => {
    if (turnStart !== undefined) {
      const d = Date.now() - turnStart;
      lastTurnMs = d;
      busyMs += d;
      turnCount++;
    }
    turnStart = undefined;
    dispatchAt = undefined;
    render(ctx);
    schedule(ctx);
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    tickerMs = undefined;
    lastStatus = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    try {
      ctx.ui.setWorkingMessage();
    } catch {
      /* ignore */
    }
  });
}

/**
 * A buffered response delivers all tokens at once: the decode window is a tiny
 * share of the response AND the implied rate is implausible. The rate check keeps
 * a normal stream after a long TTFT (e.g. a cold prefill) from being flagged.
 */
function isBulk(totalMs: number, decodeMs: number, outputTokens: number | undefined): boolean {
  if (totalMs <= 0 || decodeMs / totalMs >= BULK_RATIO) return false;
  if (!outputTokens || decodeMs <= 0) return true;
  return outputTokens / (decodeMs / 1000) > BULK_MIN_RATE;
}

/** The upstream behind an Anthropic-compatible endpoint, from the message id prefix. */
function backendOf(responseId: unknown): string | undefined {
  if (typeof responseId !== "string") return undefined;
  if (responseId.startsWith("msg_bdrk")) return "bedrock";
  if (responseId.startsWith("msg_vrtx")) return "vertex";
  if (/^msg_0[0-9]/.test(responseId)) return "anthropic";
  return undefined;
}

/** A response header, whatever the case of its name. */
function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** 950 · 8.4k · 1.2M */
function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Minute precision for the idle footer: 0m · 3m · 1h02m */
function durMinutes(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** 1.2s · 45s · 3m07s · 1h02m */
function dur(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 10) return `${s.toFixed(1)}s`;
  const sec = Math.floor(s);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
