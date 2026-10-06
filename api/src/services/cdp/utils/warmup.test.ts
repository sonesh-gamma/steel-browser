import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

import { runPageWarmup, WarmupFailedError } from "./warmup.js";

const warmupUrl = "https://render.example.com/shell";

const createLogger = () =>
  ({
    child: vi.fn().mockReturnThis(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }) as any;

const createPage = () => ({
  close: vi.fn().mockResolvedValue(undefined),
  evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
  goto: vi.fn().mockResolvedValue(undefined),
  waitForFunction: vi.fn().mockResolvedValue(undefined),
});

describe("runPageWarmup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("evaluates the init script on new documents before navigating", async () => {
    const page = createPage();

    await runPageWarmup(
      page as any,
      { url: warmupUrl, initScript: "window.__warm = true;", timeoutMs: 5000 },
      createLogger(),
    );

    expect(page.evaluateOnNewDocument).toHaveBeenCalledOnce();
    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith("window.__warm = true;");
    expect(page.evaluateOnNewDocument.mock.invocationCallOrder[0]).toBeLessThan(
      page.goto.mock.invocationCallOrder[0],
    );
  });

  it("skips init script injection when no script is given", async () => {
    const page = createPage();

    await runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger());

    expect(page.evaluateOnNewDocument).not.toHaveBeenCalled();
  });

  it("navigates with waitUntil load and polls the raw ready expression within budget", async () => {
    const page = createPage();

    await runPageWarmup(
      page as any,
      { url: warmupUrl, readyExpression: "!!window.ready", timeoutMs: 5000 },
      createLogger(),
    );

    expect(page.goto).toHaveBeenCalledOnce();
    const [gotoUrl, gotoOptions] = page.goto.mock.calls[0];
    expect(gotoUrl).toBe(warmupUrl);
    expect(gotoOptions.waitUntil).toBe("load");
    expect(gotoOptions.timeout).toBeGreaterThan(0);
    expect(gotoOptions.timeout).toBeLessThanOrEqual(5000);

    expect(page.waitForFunction).toHaveBeenCalledOnce();
    const [expression, waitOptions] = page.waitForFunction.mock.calls[0];
    expect(expression).toBe("!!window.ready");
    expect(waitOptions.polling).toBe(100);
    expect(waitOptions.timeout).toBeGreaterThan(0);
    expect(waitOptions.timeout).toBeLessThanOrEqual(5000);
  });

  it("skips readiness polling when no expression is given", async () => {
    const page = createPage();

    await runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger());

    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("maps navigation failures to phase navigation", async () => {
    const page = createPage();
    page.goto.mockRejectedValueOnce(new Error("net::ERR_CONNECTION_REFUSED"));

    await expect(
      runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger()),
    ).rejects.toMatchObject({
      name: "WarmupFailedError",
      code: "warmup_failed",
      statusCode: 502,
      phase: "navigation",
    });
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });

  it("maps readiness failures to phase readiness", async () => {
    const page = createPage();
    page.waitForFunction.mockRejectedValueOnce(new Error("Waiting failed: 5000ms exceeded"));

    await expect(
      runPageWarmup(
        page as any,
        { url: warmupUrl, readyExpression: "!!window.ready", timeoutMs: 5000 },
        createLogger(),
      ),
    ).rejects.toMatchObject({ name: "WarmupFailedError", phase: "readiness" });
  });

  it("rejects at the hard deadline when a CDP call wedges", async () => {
    vi.useFakeTimers();
    const page = createPage();
    page.goto.mockReturnValueOnce(new Promise(() => {}) as any);

    const warmup = runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger());
    const expectation = expect(warmup).rejects.toMatchObject({
      name: "WarmupFailedError",
      phase: "deadline",
    });

    await vi.advanceTimersByTimeAsync(7000);
    await expectation;
  });

  it("leaves no live timers after a successful warmup", async () => {
    vi.useFakeTimers();
    const page = createPage();

    await runPageWarmup(page as any, { url: warmupUrl, timeoutMs: 5000 }, createLogger());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("wraps unexpected failures as WarmupFailedError", async () => {
    const page = createPage();
    page.evaluateOnNewDocument.mockRejectedValueOnce(new Error("session closed"));

    await expect(
      runPageWarmup(
        page as any,
        { url: warmupUrl, initScript: "window.__warm = true;", timeoutMs: 5000 },
        createLogger(),
      ),
    ).rejects.toBeInstanceOf(WarmupFailedError);
  });

  it("leaves the warmed page intact on success", async () => {
    const page = createPage();

    await runPageWarmup(
      page as any,
      { url: warmupUrl, readyExpression: "!!window.ready", timeoutMs: 5000 },
      createLogger(),
    );

    expect(page.goto).toHaveBeenCalledOnce();
    expect(page.close).not.toHaveBeenCalled();
  });

  it("reports a readiness result and duration once, even when bootstrap JS returns 403", async () => {
    vi.stubEnv("STEEL_WARMUP_ASSET_TELEMETRY", "1");
    const page = Object.assign(new EventEmitter(), createPage());
    const logger = createLogger();
    page.goto.mockImplementationOnce(async () => {
      page.emit("requestfinished", {
        resourceType: () => "script",
        url: () => "https://render.example.com/_next/static/app.js?token=private",
        response: () => ({ status: () => 403 }),
      });
    });
    page.waitForFunction.mockRejectedValueOnce(new Error("readiness timed out"));
    await expect(
      runPageWarmup(
        page as any,
        {
          url: warmupUrl,
          readyExpression: "!!window.ready",
          timeoutMs: 5000,
        },
        logger,
      ),
    ).rejects.toMatchObject({ phase: "readiness" });
    expect(logger.info.mock.calls.map(([fields]: any[]) => fields)).toEqual([
      { event: "steel.warmup.asset", asset_kind: "next_script", outcome: "forbidden" },
      expect.objectContaining({
        event: "steel.warmup.completed",
        outcome: "failed",
        phase: "readiness",
        readiness_outcome: "failed",
        readiness_duration_ms: expect.any(Number),
        duration_ms: expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private");
    expect(page.listenerCount("requestfinished")).toBe(0);
    expect(page.listenerCount("requestfailed")).toBe(0);
  });

  it("stops observing and reports unfinished readiness at the hard deadline", async () => {
    vi.useFakeTimers();
    vi.stubEnv("STEEL_WARMUP_ASSET_TELEMETRY", "1");
    const page = Object.assign(new EventEmitter(), createPage());
    const logger = createLogger();
    page.waitForFunction.mockReturnValueOnce(new Promise(() => {}) as any);
    const warmup = runPageWarmup(
      page as any,
      { url: warmupUrl, readyExpression: "false", timeoutMs: 5000 },
      logger,
    );
    const expectation = expect(warmup).rejects.toMatchObject({ phase: "deadline" });
    await vi.advanceTimersByTimeAsync(7000);
    await expectation;
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: "steel.warmup.completed",
        outcome: "failed",
        phase: "deadline",
        readiness_outcome: "deadline",
        readiness_duration_ms: 7000,
        duration_ms: 7000,
      }),
      "Page warmup completed",
    );
    expect(page.listenerCount("requestfinished")).toBe(0);
    expect(page.listenerCount("requestfailed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not enable per-script logging by default and distinguishes skipped readiness", async () => {
    vi.stubEnv("STEEL_WARMUP_ASSET_TELEMETRY", "");
    const logger = createLogger();
    await runPageWarmup(createPage() as any, { url: warmupUrl, timeoutMs: 5000 }, logger);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: "steel.warmup.completed",
        outcome: "ready",
        phase: "complete",
        readiness_outcome: "not_requested",
      }),
      "Page warmup completed",
    );
    expect(logger.info.mock.calls[0][0]).not.toHaveProperty("readiness_duration_ms");
  });

  it("records successful polling and distinguishes navigation failures before polling", async () => {
    const page = createPage();
    const logger = createLogger();
    const options = { url: warmupUrl, readyExpression: "!!window.ready", timeoutMs: 5000 };
    await runPageWarmup(page as any, options, logger);
    expect(logger.info.mock.calls[0][0]).toMatchObject({
      outcome: "ready",
      phase: "complete",
      readiness_outcome: "ready",
      readiness_duration_ms: expect.any(Number),
    });
    page.goto.mockRejectedValueOnce(new Error("navigation failed"));
    await expect(runPageWarmup(page as any, options, logger)).rejects.toMatchObject({
      phase: "navigation",
    });
    expect(logger.info.mock.calls[1][0]).toMatchObject({
      outcome: "failed",
      phase: "navigation",
      readiness_outcome: "not_started",
    });
    expect(logger.info.mock.calls[1][0]).not.toHaveProperty("readiness_duration_ms");
  });
});
