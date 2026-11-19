// All account and transcript data in this visual test is synthetic.
const { launch } = require("./webview.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
(async () => {
  const app = await launch(false);
  try {
    const { page } = app;
    await page.bringToFront();
    page.setDefaultTimeout(10000);
    const role = (r, n) => page.getByRole(r, { name: n, exact: true });
    const slot = (s) => page.locator('[data-slot="' + s + '"]:visible').last();
    const setSize = (width) => app.resize(width, 720);
    const output = process.env.MODELGAUGE_SCREENSHOTS;
    if (output) await fs.mkdir(output, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        theme === "dark",
      );
      const checked = [];
      async function check(name, loc) {
        await loc.waitFor({ state: "visible" });
        await loc.evaluate(async (el) => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          await Promise.all(
            el.getAnimations().map((a) => a.finished.catch(() => {})),
          );
        });
        const result = await loc.evaluate((el) => {
          const ctx = document.createElement("canvas").getContext("2d");
          const rect = el.getBoundingClientRect();
          let opacity = 1;
          for (let n = el; n; n = n.parentElement)
            opacity *= Number(getComputedStyle(n).opacity);
          const alphaOf = (node) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = getComputedStyle(node).backgroundColor;
            ctx.fillRect(0, 0, 1, 1);
            return ctx.getImageData(0, 0, 1, 1).data[3];
          };
          // Some popups (the select) paint their surface on a full-size child.
          const surface =
            [el, ...el.querySelectorAll("*")].find(
              (node) =>
                alphaOf(node) > 0 &&
                node.getBoundingClientRect().width >= rect.width * 0.9 &&
                node.getBoundingClientRect().height >= rect.height * 0.9,
            ) ?? el;
          return {
            alpha: alphaOf(surface),
            blurred: getComputedStyle(surface).backdropFilter.includes("blur("),
            opacity,
            width: rect.width,
            height: rect.height,
          };
        });
        // T3's popups are glass: a mostly opaque fill over a blurred backdrop.
        assert.ok(
          result.alpha === 255 || (result.alpha >= 190 && result.blurred),
          name + " fill " + theme + " " + JSON.stringify(result),
        );
        assert.ok(
          result.opacity > 0.99 && result.width > 1 && result.height > 1,
          name + " geometry/opacity " + JSON.stringify(result),
        );
        if (output)
          await loc.screenshot({
            path: path.join(output, theme + "-" + name + ".png"),
            animations: "disabled",
          });
        checked.push(name);
      }
      const close = async (loc) => {
        await page.keyboard.press("Escape");
        await loc.waitFor({ state: "hidden" });
      };
      await setSize(1070);
      await role("button", "Cost").click();
      await role("button", "All providers").click();
      await check("providers", slot("menu-popup"));
      await close(slot("menu-popup"));
      await role("button", "All environments").click();
      await check("environments", slot("menu-popup"));
      await role("menuitem", "Model prices").click();
      await check("prices", slot("dialog-popup"));
      await page
        .locator('button[aria-labelledby*="usage-prices-apply-label"]')
        .click();
      await check("price-environments", slot("menu-popup"));
      await close(slot("menu-popup"));
      const priceReset = page.locator('[aria-label*="to automatic"]').first();
      await priceReset.scrollIntoViewIfNeeded();
      await page.keyboard.press("Tab");
      await priceReset.focus();
      await check("price-hint", slot("tooltip-popup"));
      await page.keyboard.press("Tab");
      await close(slot("dialog-popup"));
      await role("button", "Unpriced usage details").press("Enter");
      await check("unpriced", slot("popover-popup"));
      await close(slot("popover-popup"));
      const plot = page.locator("div.relative.h-56.flex-1").first();
      await plot.hover();
      await check("chart", page.locator(".surface-glass:visible").last());
      await page.mouse.move(1, 1);
      const costBar = page
        .locator('[aria-hidden] [data-slot="tooltip-trigger"]')
        .first();
      // Scrolling dismisses this tooltip. Let the scroll settle before entering the thin bar.
      await costBar.scrollIntoViewIfNeeded();
      await costBar.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await costBar.hover();
      await check("breakdown-hint", slot("tooltip-popup"));
      await page.mouse.move(1, 1);
      await page
        .locator("tbody button")
        .filter({ hasText: "example-model" })
        .click();
      await check("model", slot("dialog-popup"));
      const modelLine = slot("dialog-popup").locator('path[fill="none"][vector-effect="non-scaling-stroke"]');
      assert.ok(await modelLine.first().evaluate((line) => line.getBBox().height > 0), "Model trend must plot the fixture usage");
      await close(slot("dialog-popup"));
      await setSize(520);
      for (const [name, label] of [
        ["period", "Usage period"],
        ["metric", "Usage metric"],
      ]) {
        await role("combobox", label).click();
        await check(name, slot("select-popup"));
        await close(slot("select-popup"));
      }
      await setSize(1070);
      if (theme === "light") {
        await page.evaluate(() => {
          window.fixtureLimitsGate = new Promise((resolve) => { window.finishLimits = resolve; });
        });
      }
      await role("button", "Limits").click();
      if (theme === "light") {
        await page.getByRole("status").filter({ hasText: "Checking provider limits" }).waitFor();
        assert.equal(await page.getByText("No provider on the selected environments reports subscription limits.").isVisible(), false);
        await page.evaluate(() => window.finishLimits());
      }
      const bar = page
        .getByRole("button", { name: /Example account.*10% left/ })
        .first();
      await bar.press("Enter");
      await check("account", slot("popover-popup"));
      await role("button", "Use reset").press("Enter");
      await check("confirmation", slot("alert-dialog-popup"));
      await role("button", "Cancel").click();
      console.log(theme + " verified: " + checked.join(", "));
    }
    await page.evaluate(() => { window.fixtureEmptyLimits = true; });
    await role("button", "Refresh limits").click();
    await page.getByText("No provider on the selected environments reports subscription limits.").waitFor();
    await role("button", "Cost").click();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
    // The local date crosses UTC midnight and the autumn clock change.
    const end = "2026-11-02T04:30:00.000Z";
    await page.clock.setFixedTime(new Date(end));
    await role("button", "Today").click();
    await page.waitForFunction((end) => window.fixtureSummaryWindow?.untilTime === end, end);
    let query = await page.evaluate(() => window.fixtureSummaryWindow);
    assert.equal(query.sinceTime, "2026-11-01T04:00:00.000Z");
    assert.equal(query.sinceDay, "2026-11-01");
    assert.equal(query.untilDay, query.sinceDay);
    assert.equal(query.resolution, "hour");
    await page.reload();
    await page.waitForFunction((end) => window.fixtureSummaryWindow?.untilTime === end, end);
    await setSize(520);
    await role("combobox", "Usage period").click();
    assert.equal(await page.getByRole("option").first().innerText(), "Today");
    await role("option", "Past 24h").click();
    await page.waitForFunction(() => window.fixtureSummaryWindow?.sinceTime === "2026-11-01T04:30:00.000Z");
    await page.clock.setFixedTime(new Date("2026-11-02T05:15:00Z"));
    await role("combobox", "Usage period").click();
    await role("option", "Today").click();
    await page.waitForFunction(() => window.fixtureSummaryWindow?.sinceTime === "2026-11-02T05:00:00.000Z");
    await page.locator("tbody button").filter({ hasText: "example-model" }).click();
    await slot("dialog-popup").locator("svg circle[r='3']").first().waitFor({ state: "visible" });
    console.log("Today and Past 24h passed on wide and compact layouts, including the DST change and the first hour.");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
