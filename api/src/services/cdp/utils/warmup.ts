import { FastifyBaseLogger } from "fastify";
import { Page } from "puppeteer-core";
import { observeWarmupAssets } from "./warmup-observability.js";

export type WarmupPhase = "navigation" | "readiness" | "deadline";

export class WarmupFailedError extends Error {
  public readonly statusCode = 502;
  public readonly code = "warmup_failed";

  constructor(
    url: string,
    public readonly phase: WarmupPhase,
    cause: unknown,
  ) {
    super(
      `Warmup of ${url} failed during ${phase}: ${cause instanceof Error ? cause.message : cause}`,
    );
    this.name = "WarmupFailedError";
  }
}

export interface WarmupOptions {
  url: string;
  initScript?: string;
  readyExpression?: string;
  timeoutMs: number;
}

// Extra slack past the caller's budget before the hard deadline fires. The
// puppeteer calls below carry their own timeouts; this only trips when a CDP
// call wedges entirely, so it can never hold the session lifecycle lock open.
const HARD_DEADLINE_GRACE_MS = 2000;

/**
 * Navigate `page` to the warmup URL and block until it is ready. The page is
 * left intact on success so an attaching CDP client adopts it as-is. Failures
 * reject with WarmupFailedError; the caller owns browser teardown.
 */
export async function runPageWarmup(
  page: Page,
  options: WarmupOptions,
  logger: FastifyBaseLogger,
): Promise<void> {
  const { url, initScript, readyExpression, timeoutMs } = options;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const budget = () => Math.max(deadline - Date.now(), 1);
  const stopObserving =
    process.env.STEEL_WARMUP_ASSET_TELEMETRY === "1"
      ? observeWarmupAssets(page, url, logger)
      : undefined;
  let outcome: "ready" | "failed" = "failed";
  let phase: WarmupPhase | "complete" = "navigation";
  let readinessStartedAt: number | undefined;
  let readinessDurationMs: number | undefined;
  let readinessOutcome = readyExpression ? "not_started" : "not_requested";

  const warm = async (): Promise<void> => {
    if (initScript) {
      await page.evaluateOnNewDocument(initScript);
    }

    try {
      await page.goto(url, { waitUntil: "load", timeout: budget() });
    } catch (error) {
      throw new WarmupFailedError(url, "navigation", error);
    }

    if (readyExpression) {
      readinessStartedAt = Date.now();
      readinessOutcome = "pending";
      try {
        // Pass the raw string: puppeteer evaluates it via Runtime.evaluate,
        // which is CSP-immune and sidesteps the esbuild __name serialization
        // workaround that function-valued evaluate needs.
        await page.waitForFunction(readyExpression, { polling: 100, timeout: budget() });
        readinessOutcome = "ready";
      } catch (error) {
        readinessOutcome = "failed";
        throw new WarmupFailedError(url, "readiness", error);
      } finally {
        readinessDurationMs = Date.now() - readinessStartedAt;
      }
    }
  };

  let hardDeadlineTimer: NodeJS.Timeout | undefined;
  const hardDeadline = new Promise<never>((_, reject) => {
    hardDeadlineTimer = setTimeout(() => {
      reject(
        new WarmupFailedError(
          url,
          "deadline",
          new Error(`warmup did not settle within ${timeoutMs + HARD_DEADLINE_GRACE_MS}ms`),
        ),
      );
    }, timeoutMs + HARD_DEADLINE_GRACE_MS);
  });

  try {
    const warmPromise = warm();
    // If the hard deadline wins the race the abandoned warm promise may still
    // reject later (e.g. when the browser is killed); keep that from surfacing
    // as an unhandled rejection.
    warmPromise.catch(() => {});
    await Promise.race([warmPromise, hardDeadline]);
    outcome = "ready";
    phase = "complete";
    logger.debug(`[Warmup] Page warmed at ${url} in ${Date.now() - startedAt}ms`);
  } catch (error) {
    phase = error instanceof WarmupFailedError ? error.phase : "navigation";
    throw error instanceof WarmupFailedError
      ? error
      : new WarmupFailedError(url, "navigation", error);
  } finally {
    clearTimeout(hardDeadlineTimer);
    stopObserving?.();
    logger.info(
      {
        event: "steel.warmup.completed",
        outcome,
        phase,
        duration_ms: Date.now() - startedAt,
        readiness_outcome: readinessOutcome === "pending" ? "deadline" : readinessOutcome,
        ...(readinessStartedAt === undefined
          ? {}
          : {
              readiness_duration_ms: readinessDurationMs ?? Date.now() - readinessStartedAt,
            }),
      },
      "Page warmup completed",
    );
  }
}
