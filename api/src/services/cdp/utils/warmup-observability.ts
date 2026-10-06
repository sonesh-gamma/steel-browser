import type { FastifyBaseLogger } from "fastify";
import type { HTTPRequest, Page } from "puppeteer-core";

type AssetOutcome =
  | "ok"
  | "forbidden"
  | "server_error"
  | "client_error"
  | "redirect"
  | "network_error"
  | "unknown";

/** Observe bootstrap script requests during warmup, before any client attaches.
 * The caller removes listeners when warmup settles, including at its hard deadline.
 * No request URL, session identifier, or error text is logged by this observer.
 */
export function observeWarmupAssets(
  page: Pick<Page, "on" | "off">,
  warmupUrl: string,
  logger: FastifyBaseLogger,
): () => void {
  const origin = new URL(warmupUrl).origin;
  const recorded = new WeakSet<HTTPRequest>();
  const record = (request: HTTPRequest, failed: boolean) => {
    if (request.resourceType() !== "script" || recorded.has(request)) {
      return;
    }
    try {
      const url = new URL(request.url());
      if (url.origin !== origin || !url.pathname.startsWith("/_next/")) {
        return;
      }
    } catch {
      return;
    }
    recorded.add(request);
    const status = request.response()?.status();
    let outcome: AssetOutcome = "unknown";
    if (status === 403) {
      outcome = "forbidden";
    } else if (status !== undefined && status >= 500) {
      outcome = "server_error";
    } else if (status !== undefined && status >= 400) {
      outcome = "client_error";
    } else if (failed) {
      outcome = "network_error";
    } else if (status === 304) {
      outcome = "ok";
    } else if (status !== undefined && status >= 300) {
      outcome = "redirect";
    } else if (status !== undefined && status >= 200) {
      outcome = "ok";
    }
    logger.info(
      { event: "steel.warmup.asset", asset_kind: "next_script", outcome },
      "Warmup script request completed",
    );
  };
  const finished = (request: HTTPRequest) => record(request, false);
  const failed = (request: HTTPRequest) => record(request, true);
  page.on("requestfinished", finished);
  page.on("requestfailed", failed);
  return () => {
    page.off("requestfinished", finished);
    page.off("requestfailed", failed);
  };
}
