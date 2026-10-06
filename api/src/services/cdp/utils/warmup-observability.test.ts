import { EventEmitter } from "node:events";
import type { FastifyBaseLogger } from "fastify";
import type { HTTPRequest, Page } from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import { observeWarmupAssets } from "./warmup-observability.js";

const request = (
  status?: number,
  url = "https://render.example.com/_next/static/app.js?secret=private",
  type = "script",
) =>
  ({
    url: () => url,
    resourceType: () => type,
    response: () => (status === undefined ? null : { status: () => status }),
  }) as HTTPRequest;

describe("observeWarmupAssets", () => {
  it("counts each terminal script request once, including the successful denominator", () => {
    const page = new EventEmitter();
    const logger = { info: vi.fn() };
    const stop = observeWarmupAssets(
      page as unknown as Page,
      "https://render.example.com/shell",
      logger as unknown as FastifyBaseLogger,
    );
    for (const status of [200, 304, 403, 503, 404, 302]) {
      const item = request(status);
      page.emit("requestfinished", item);
      page.emit("requestfailed", item);
    }
    page.emit("requestfailed", request());
    page.emit("requestfinished", request());
    expect(logger.info.mock.calls.map(([fields]) => fields.outcome)).toEqual([
      "ok",
      "ok",
      "forbidden",
      "server_error",
      "client_error",
      "redirect",
      "network_error",
      "unknown",
    ]);
    for (const [fields] of logger.info.mock.calls) {
      expect(Object.keys(fields).sort()).toEqual(["asset_kind", "event", "outcome"]);
      expect(fields.event).toBe("steel.warmup.asset");
      expect(fields.asset_kind).toBe("next_script");
    }
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private");
    stop();
    stop();
    expect(page.listenerCount("requestfinished")).toBe(0);
    expect(page.listenerCount("requestfailed")).toBe(0);
    page.emit("requestfinished", request(403));
    expect(logger.info).toHaveBeenCalledTimes(8);
  });

  it("excludes other origins, non-Next scripts and non-script resources", () => {
    const page = new EventEmitter();
    const logger = { info: vi.fn() };
    const stop = observeWarmupAssets(
      page as unknown as Page,
      "https://render.example.com/shell",
      logger as unknown as FastifyBaseLogger,
    );
    page.emit("requestfinished", request(403, "https://other.example/_next/app.js"));
    page.emit("requestfinished", request(403, "https://render.example.com/analytics.js"));
    page.emit("requestfinished", request(403, "https://render.example.com/_next/image", "image"));
    expect(logger.info).not.toHaveBeenCalled();
    stop();
  });
});
