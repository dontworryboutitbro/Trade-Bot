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

test.describe("live activation safety", () => {
  test("live modes cannot be enabled via the API without the full ceremony", async ({ request }) => {
    const attempt = await request.post("/api/admin/mode", {
      data: { from: "MOCK", to: "LIVE_AUTONOMOUS" },
    });
    expect(attempt.ok()).toBeFalsy();
    const status = await request.get("/api/status");
    const body = await status.json();
    expect(body.mode).toBe("MOCK");
  });
});
