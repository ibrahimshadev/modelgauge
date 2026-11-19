const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright-core");
const installFixture = require("./webview-fixture.cjs");

const run = promisify(execFile);

async function launch(desktop) {
  assert.equal(process.platform, "win32", "Run these tests with Windows Node.js.");
  const exe = path.resolve(process.env.MODELGAUGE_EXECUTABLE || "src-tauri/target/release/modelgauge.exe");
  await fs.access(exe);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "modelgauge-webview-"));
  const env = {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0",
  };
  const child = spawn(exe, [], { env, stdio: "inherit" });
  const exited = new Promise((resolve) => {
    child.once("error", (err) => resolve(err.message));
    child.once("exit", (code, signal) => resolve(signal || String(code)));
  });
  let browser;
  async function close() {
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        await run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
      await exited;
    } finally {
      await browser?.close();
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
  try {
    // A fresh WebView2 profile publishes its own ephemeral CDP port here.
    const deadline = Date.now() + 45000;
    let port;
    while (!port && Date.now() < deadline) {
      const status = await Promise.race([exited, delay(150, null)]);
      assert.equal(status, null, "ModelGauge exited before CDP attachment: " + status);
      for (const dir of [profile, path.join(profile, "EBWebView")]) {
        const active = await fs.readFile(path.join(dir, "DevToolsActivePort"), "utf8")
          .catch((err) => { if (err.code !== "ENOENT") throw err; });
        if (active && /^\d+\r?\n\/devtools\/browser\//.test(active)) {
          port = Number(active.split("\n")[0]);
          break;
        }
      }
    }
    assert.ok(port, "WebView2 did not publish DevToolsActivePort in its temporary profile");
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
      noDefaults: true,
      timeout: 15000,
    });
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.waitForEvent("page", { timeout: 15000 });
    await page.waitForURL(/^https?:\/\/tauri\.localhost(?:\/|$)/, { timeout: 15000 });
    const errors = [];
    page.on("pageerror", (err) => {
      errors.push(err.message);
      console.error("UI error", err.message);
    });
    if (desktop) {
      await page.waitForFunction(() => !!window.gauge);
      await page.evaluate(installFixture, true);
    } else {
      await page.addInitScript(installFixture, false);
      await page.reload();
    }
    assert.equal(await page.evaluate(() => window.fixtureClaims === 0 &&
      Object.isFrozen(window.gauge) && !!window.__TAURI_INTERNALS__), true);

    const windowCommand = (...args) => run("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(__dirname, "webview-window.ps1"), String(child.pid), ...args.map(String),
    ]);
    return {
      page, errors, close,
      resize: (width, height) => windowCommand("resize", width, height),
      waitVisible: (visible) => windowCommand(visible ? "visible" : "hidden"),
      reopen: () => run(exe, [], { env, timeout: 10000 }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
module.exports = { launch };
