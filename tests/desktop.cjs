const { launch } = require("./webview.cjs");
const assert = require("node:assert/strict");
(async () => {
  const app = await launch(true);
  try {
    const { page: win, errors } = app;
    win.setDefaultTimeout(25000);
    const button = (name) => win.getByRole("button", { name, exact: true });
    const text = (name) =>
      win.getByText(name, { exact: true }).filter({ visible: true }).first();
    await text("Cost").click();
    await text("Tokens").click();
    await text("30 days").click();
    await text("7 days").click();
    await button("All providers").click();
    const popup = win.getByRole("menu");
    for (const theme of ["dark", "light"]) {
      await win.emulateMedia({ colorScheme: theme });
      const fill = await popup.evaluate((el) => {
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.fillStyle = getComputedStyle(el).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        return {
          alpha: ctx.getImageData(0, 0, 1, 1).data[3],
          blurred: getComputedStyle(el).backdropFilter.includes("blur("),
        };
      });
      // T3's menus are glass: a mostly opaque fill over a blurred backdrop.
      assert.ok(
        fill.alpha === 255 || (fill.alpha >= 190 && fill.blurred),
        "Provider menu must stay legible in " + theme + " mode " + JSON.stringify(fill),
      );
    }
    const providers = win.getByRole("menuitemcheckbox");
    await providers.filter({ hasText: "Claude Code" }).click();
    assert.equal(
      await providers
        .filter({ hasText: "Claude Code" })
        .getAttribute("aria-checked"),
      "false",
    );
    await providers.filter({ hasText: "Claude Code" }).click();
    await win.keyboard.press("Escape");
    // A report warning adds its accessible description to the trigger name.
    await win.getByRole("button", { name: /^All environments\b/ }).click();
    const envs = await win.evaluate(async () => {
      const envs = await window.gauge.environments();
      // Exercise each real worker, including Windows' extended-length resource path.
      for (const { id } of envs) await window.gauge.request(id, "prices");
      return envs;
    });
    for (const env of envs)
      await win
        .getByRole("menuitemcheckbox")
        .filter({ hasText: env.label })
        .waitFor();
    if (envs.length > 1) {
      const first = win
        .getByRole("menuitemcheckbox")
        .filter({ hasText: envs[0].label })
        .first();
      await first.click();
      assert.equal(await first.getAttribute("aria-checked"), "false");
      await first.click();
    }
    await win.getByRole("menuitem", { name: "Model prices" }).click();
    await button("Add model price").click();
    await win.getByLabel("New model ID").fill("fixture-unsaved");
    await win.keyboard.press("Escape");
    await text("Cost").click();
    await win.getByRole("heading", { name: "Totals", exact: true }).waitFor();
    await win
      .getByRole("heading", { name: "Breakdown", exact: true })
      .waitFor();
    const modelRow = win
      .getByRole("table", { name: "Usage breakdown", exact: true })
      .getByRole("button")
      .first();
    if (await modelRow.count()) {
      await modelRow.click();
      await win.getByRole("dialog").waitFor();
      await win.keyboard.press("Escape");
    }
    await text("Limits").click();
    const segment = win
      .getByRole("button", { name: /Fixture account.*5% left/i })
      .first();
    await segment.press("Enter");
    await button("Use reset").press("Enter");
    await button("Cancel").click();
    assert.equal(await win.evaluate(() => window.fixtureClaims), 0);
    await win.getByRole("alertdialog").waitFor({ state: "hidden" });
    await win.mouse.move(0, 0);
    await segment.press("Enter");
    await button("Use reset").press("Enter");
    await button("Use credit").click();
    await win.waitForFunction(
      () => !document.querySelector('[role="alertdialog"]'),
    );
    assert.equal(await win.evaluate(() => window.fixtureClaims), 1);
    await button("Refresh limits").first().waitFor();
    await app.waitVisible(true);
    await button("Hide in tray").click();
    await app.waitVisible(false);
    await app.reopen();
    await app.waitVisible(true);
    await win.waitForFunction(() => document.visibilityState === "visible");
    assert.deepEqual(errors, []);
    console.log(
      "Passed desktop controls, environment discovery (" +
        envs.map((e) => e.label).join(", ") +
        "), filters, price dialog, limits, hide and reopen.",
    );
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
