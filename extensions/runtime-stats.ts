/**
 * pi-runtime-stats
 *
 * Adds timing and cache telemetry to pi's footer, and turns the "Working…"
 * row into a live per-request timer.
 *
 * Footer:
 *   turn 4.2s      wall time of the current prompt (agent_start → agent_settled)
 *   step 3         LLM round-trips inside that turn
 *   prefill 3.8s   dispatch → first streamed token (TTFT)
 *   decode 120t/s  output rate measured over the streaming window
 *   cache 99.8%    prompt-cache hit rate of the latest LLM call
 *   avg 74.8%      prompt-cache hit rate across the whole session
 *   session 12m03s wall time since the session started (minutes while idle)
 *   busy 68%       share of session time the agent was actually working
 *   turns 7        completed turns
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
/** Decode window shorter than this fraction of the response ⇒ treat as buffered. */
const BULK_RATIO = 0.05;

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
  let lastNow: number | undefined;

  /**
   * Walks session entries once and derives both cache figures.
   * `now` reproduces pi's built-in CH indicator (latest assistant message);
   * `avg` is the cumulative session ratio.
   */
  function cacheHits(ctx: ExtensionContext): { now?: number; avg?: number } {
    try {
      const entries = ctx.sessionManager.getEntries() as any[];
      // Rescan from the start when the entry list is not an extension of the last scan
      // (session switch, fork, tree navigation).
      if (scanned > entries.length || (scanned > 0 && entries[scanned - 1] !== lastScannedEntry)) {
        scanned = 0;
        sumInput = 0;
        sumRead = 0;
        sumWrite = 0;
        lastNow = undefined;
      }
      for (; scanned < entries.length; scanned++) {
        const entry = entries[scanned];
        const isAssistant =
          entry?.type === "message" && entry.message?.role === "assistant";
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

        if (isAssistant) {
          const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          lastNow = prompt > 0 ? ((u.cacheRead ?? 0) / prompt) * 100 : undefined;
        }
      }
      lastScannedEntry = entries[scanned - 1];
    } catch {
      return {};
    }
    const prompt = sumInput + sumRead + sumWrite;
    return { now: lastNow, avg: prompt > 0 ? (sumRead / prompt) * 100 : undefined };
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
      const parts: string[] = [];
      const kv = (label: string, value: string, hot = false) =>
        t.fg("muted", `${label} `) + t.fg(hot ? "accent" : "dim", value);

      if (turnStart !== undefined) {
        parts.push(kv("turn", dur(Date.now() - turnStart), true));
        if (stepInTurn > 0) parts.push(kv("step", String(stepInTurn), true));
      } else if (lastTurnMs !== undefined) {
        parts.push(kv("turn", dur(lastTurnMs)));
        if (stepInTurn > 0) parts.push(kv("step", String(stepInTurn)));
      }

      if (lastPrefillMs !== undefined) parts.push(kv("prefill", dur(lastPrefillMs)));
      if (lastDecodeMs !== undefined) {
        if (lastWasBulk) {
          parts.push(kv("decode", "n/a(bulk)"));
        } else if (lastOutputTokens && lastDecodeMs > 0) {
          const tps = lastOutputTokens / (lastDecodeMs / 1000);
          parts.push(kv("decode", `${tps.toFixed(0)}t/s`));
        }
      }

      const { now, avg } = cacheHits(ctx);
      if (now !== undefined) parts.push(kv("cache", `${now.toFixed(1)}%`));
      if (avg !== undefined) parts.push(kv("avg", `${avg.toFixed(1)}%`));

      const elapsed = Date.now() - sessionStart;
      parts.push(kv("session", isBusy() ? dur(elapsed) : durMinutes(elapsed)));
      const liveBusy = busyMs + (turnStart !== undefined ? Date.now() - turnStart : 0);
      if (elapsed > 0 && liveBusy > 0) {
        parts.push(kv("busy", `${Math.min(100, (liveBusy / elapsed) * 100).toFixed(0)}%`));
      }
      if (turnCount > 0) parts.push(kv("turns", String(turnCount)));

      const status = parts.join(t.fg("muted", "  "));
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
  // session_start does not fire again on resume/fork, so without these the
  // session clock would carry over from the previous session.
  pi.on("session_before_switch", async (_e, ctx) => arm(ctx, true));
  pi.on("session_before_fork", async (_e, ctx) => arm(ctx, true));

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

  pi.on("message_update", async (_e, ctx) => {
    if (dispatchAt !== undefined && firstTokenAt === undefined) {
      firstTokenAt = Date.now();
      lastPrefillMs = firstTokenAt - dispatchAt;
      renderWorking(ctx);
    }
  });

  pi.on("message_end", async (event: any, ctx) => {
    if (event?.message?.role !== "assistant") return;
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
      lastWasBulk = total > 0 && lastDecodeMs / total < BULK_RATIO;
      lastOutputTokens = event?.message?.usage?.output;
    }
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
