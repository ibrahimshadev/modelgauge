const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const install = require("./webview-fixture.cjs");

test("both WebView suites keep every reset inside the fixture", async () => {
  for (const desktop of [false, true]) {
    const window = {};
    vm.runInNewContext(`(${install})(desktop)`, { window, desktop });
    const forwarded = [];
    window.gauge ??= { request: (...args) => forwarded.push(args) };
    const reset = (env, id) => window.gauge.request(env, "reset", {
      instanceId: "codex", creditId: id,
    });
    await assert.rejects(reset("second", "fixture"));
    await assert.rejects(reset("local", "another-credit"));
    if (desktop) await reset("local", undefined);
    await assert.rejects(reset("local", "fixture"));
    assert.equal(window.fixtureClaims, Number(desktop));
    assert.deepEqual(forwarded, []);
  }
});
