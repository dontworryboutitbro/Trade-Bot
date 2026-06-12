import { expect, test } from "@playwright/test";

test.describe("dashboard (mock mode)", () => {
  test("overview loads with mock portfolio", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Fable Fund Lab").first()).toBeVisible();
    await expect(page.getByText("Mock Mode").first()).toBeVisible();
    await expect(page.getByText("Portfolio value", { exact: false })).toBeVisible();
    await expect(page.getByText("Emergency controls", { exact: false })).toBeVisible();
  });

  test("login page explains open mock mode when Supabase is missing", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Supabase is not configured")).toBeVisible();
  });

  test("positions page renders the mock holdings", async ({ page }) => {
    await page.goto("/positions");
    await expect(page.getByRole("heading", { name: "Positions" })).toBeVisible();
    await expect(page.getByText("SPY").first()).toBeVisible();
  });

  test("settings shows diagnostics as missing without credentials", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText("Diagnostics — connections")).toBeVisible();
    await expect(page.getByText("Anthropic API", { exact: false })).toBeVisible();
    const missing = page.getByText("Missing");
    await expect(missing.first()).toBeVisible();
  });

  test("setup wizard shows checklists", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByText("Paper readiness checklist")).toBeVisible();
    await expect(page.getByText("Future live-readiness checklist")).toBeVisible();
    await expect(page.getByText("Locked", { exact: true })).toBeVisible();
  });
});

test.describe("approval flow (mock mode)", () => {
  test("AI evaluation creates a proposal that can be approved and executed", async ({
    page,
    request,
  }) => {
    const run = await request.post("/api/admin/run", { data: { job: "AI_EVALUATION" } });
    expect(run.ok()).toBeTruthy();
    const body = await run.json();
    test.skip(body.result.proposalsCreated === 0, "mock AI chose NO_ACTION (portfolio full)");

    await page.goto("/");
    await expect(page.getByText("Awaiting your approval")).toBeVisible();
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Approve & execute" }).first().click();
    await expect(page.getByText("Awaiting your approval")).toBeHidden({ timeout: 15_000 });

    await page.goto("/activity?filter=executed");
    await expect(page.getByText("EXECUTED").first()).toBeVisible();
  });
});

test.describe("kill switch flow (mock mode)", () => {
  test("engage blocks evaluation; reset requires typed phrase", async ({ page, request }) => {
    // Engage via the UI button (prompt dialog supplies the reason).
    await page.goto("/settings");
    page.once("dialog", (dialog) => dialog.accept("e2e test"));
    await page.getByRole("button", { name: "Global kill switch" }).click();
    // Server components re-render after router.refresh(): the engage button
    // becomes the reset button once the switch is on.
    await expect(page.getByRole("button", { name: "Reset kill switch" })).toBeVisible({
      timeout: 15_000,
    });

    // Evaluation is skipped while engaged.
    const run = await request.post("/api/admin/run", { data: { job: "AI_EVALUATION" } });
    const body = await run.json();
    expect(body.result.proposalsCreated).toBe(0);

    // Wrong phrase fails.
    const badReset = await request.post("/api/admin/kill-switch", {
      data: { action: "RESET", acknowledgment: "wrong" },
    });
    expect(badReset.ok()).toBeFalsy();

    // Correct phrase resets; then re-enable orders.
    const reset = await request.post("/api/admin/kill-switch", {
      data: { action: "RESET", acknowledgment: "RESET KILL SWITCH" },
    });
    expect(reset.ok()).toBeTruthy();
    await request.post("/api/admin/stop-orders", { data: { stop: false } });
  });
});

test.describe("strategy lab v2 pages (mock mode)", () => {
  test("strategy lab renders the comparison table and promotion gates", async ({ page }) => {
    await page.goto("/strategy-lab");
    await expect(page.getByRole("heading", { name: "Strategy Lab" })).toBeVisible();
    await expect(page.getByText("Trend-Following Pullback").first()).toBeVisible();
    await expect(page.getByText("Past paper performance does not guarantee live results.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run backtest" })).toBeVisible();
  });

  test("a mock backtest runs end to end with walk-forward output", async ({ request }) => {
    const res = await request.post("/api/admin/backtest", {
      data: { strategyId: "mean-reversion", days: 500, costBpsPerSide: 10 },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.result.metrics).toBeDefined();
    expect(body.result.walkForward).toBeDefined();
    expect(typeof body.result.metrics.totalReturnPct).toBe("number");
  });

  test("paper journal renders with filters and CSV export", async ({ page, request }) => {
    await page.goto("/paper-journal");
    await expect(page.getByRole("heading", { name: "Paper Journal" })).toBeVisible();
    await expect(page.getByText("Export CSV")).toBeVisible();
    const csv = await request.get("/api/journal-export");
    expect(csv.ok()).toBeTruthy();
    expect((await csv.text()).split("\n")[0]).toContain("symbol,strategy");
  });

  test("cross-market research renders read-only with the divergence banner", async ({ page }) => {
    await page.goto("/cross-market");
    await expect(page.getByRole("heading", { name: "Cross-Market Research" })).toBeVisible();
    await expect(
      page.getByText("Divergences may reflect different expiries", { exact: false }),
    ).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("learning engine (mock mode)", () => {
  test("daily learning runs via the admin trigger and renders on /learning", async ({
    page,
    request,
  }) => {
    const run = await request.post("/api/admin/run", { data: { job: "LEARN_DAILY" } });
    expect(run.ok()).toBeTruthy();
    const body = await run.json();
    expect(body.result.narrative).toContain("Learning run complete");

    await page.goto("/learning");
    await expect(page.getByRole("heading", { name: "Learning", exact: true })).toBeVisible();
    await expect(page.getByText("Daily learning report", { exact: false })).toBeVisible();
    await expect(page.getByText("Champion vs challenger")).toBeVisible();
    await expect(page.getByText("Confidence calibration")).toBeVisible();
  });

  test("learning cron routes require CRON_SECRET", async ({ request }) => {
    expect((await request.get("/api/cron/learn-daily")).status()).toBe(401);
    expect((await request.get("/api/cron/validate-weekly")).status()).toBe(401);
  });
});

test.describe("live activation safety", () => {
  test("live modes cannot be enabled via the API without the full ceremony", async ({ request }) => {
    for (const to of ["LIVE_AUTONOMOUS", "LIVE_MANUAL", "LIVE_MANUAL_PILOT"]) {
      const attempt = await request.post("/api/admin/mode", { data: { from: "MOCK", to } });
      expect(attempt.ok()).toBeFalsy();
    }
    const status = await request.get("/api/status");
    const body = await status.json();
    expect(body.mode).toBe("MOCK");
  });
});

test.describe("scanner (mock mode)", () => {
  test("universe refresh runs and the scanner page renders counts + candidates", async ({
    page,
    request,
  }) => {
    const run = await request.post("/api/admin/run", { data: { job: "UNIVERSE_REFRESH" } });
    expect(run.ok()).toBeTruthy();
    const body = await run.json();
    expect(body.result.discovered.equities).toBeGreaterThan(0);
    expect(body.result.discovered.crypto).toBeGreaterThan(0);

    await page.goto("/scanner");
    await expect(page.getByRole("heading", { name: "Scanner" })).toBeVisible();
    await expect(page.getByText("Equities discovered", { exact: false })).toBeVisible();
    await expect(page.getByText("Top ranked candidates", { exact: false })).toBeVisible();
    await expect(page.getByText("trade selectively", { exact: false })).toBeVisible();
  });
});

test.describe("live readiness (mock mode)", () => {
  test("readiness page renders with drills, feed warning, and capital stages", async ({ page }) => {
    await page.goto("/settings/live-readiness");
    await expect(page.getByRole("heading", { name: "Live readiness" })).toBeVisible();
    await expect(page.getByText("IEX — LIMITED COVERAGE")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run all drills" })).toBeVisible();
    await expect(page.getByText("Live allocation changes require manual approval", { exact: false })).toBeVisible();
  });

  test("drills run end to end and report mandatory status", async ({ request }) => {
    const res = await request.post("/api/admin/drills", { data: {} });
    expect(res.ok()).toBeTruthy();
    const { run } = await res.json();
    expect(run.results.length).toBeGreaterThanOrEqual(12);
    const failed = run.results.filter((r: { mandatory: boolean; status: string }) => r.mandatory && r.status === "FAIL");
    expect(failed).toEqual([]);
  });

  test("capital stage changes require the typed confirmation", async ({ request }) => {
    const bad = await request.post("/api/admin/pilot-stage", {
      data: { stage: "PILOT_500", confirmation: "yes", reason: "test" },
    });
    expect(bad.ok()).toBeFalsy();
  });
});
