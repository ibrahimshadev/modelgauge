const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInterface } = require("node:readline");
const { once } = require("node:events");

test("standalone report prices, deduplicates, matches models and redeems only a verified fixture credit", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "modelgauge-worker-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    PATH: dir,
    HOME: dir,
    USERPROFILE: dir,
    XDG_DATA_HOME: dir,
    XDG_CONFIG_HOME: dir,
    LOCALAPPDATA: dir,
    T3CODE_HOME: path.join(dir, "t3"),
    MODELGAUGE_HOME: path.join(dir, "gauge"),
    CODEX_HOME: path.join(dir, "codex"),
    CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
  };
  for (const d of [
    env.CODEX_HOME,
    path.join(env.CLAUDE_CONFIG_DIR, "projects", "test"),
    path.join(env.T3CODE_HOME, "userdata"),
  ])
    await fs.mkdir(d, { recursive: true });
  const today = new Date().toISOString();
  const record = {
    type: "assistant",
    timestamp: today,
    sessionId: "s",
    requestId: "r",
    message: {
      id: "m",
      model: "fixture-model",
      usage: {
        input_tokens: 1000000,
        output_tokens: 500000,
        cache_read_input_tokens: 1000000,
      },
    },
  };
  await fs.writeFile(
    path.join(env.CLAUDE_CONFIG_DIR, "projects", "test", "conversation.jsonl"),
    [record, record].map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  await fs.writeFile(
    path.join(env.CODEX_HOME, "auth.json"),
    JSON.stringify({
      tokens: { access_token: "fixture", account_id: "fixture-account" },
    }),
  );
  const original = JSON.stringify({ usageModelAliases: {} });
  const t3Settings = path.join(env.T3CODE_HOME, "userdata", "settings.json");
  await fs.writeFile(t3Settings, original);
  const child = spawn(
    process.execPath,
    ["--require", path.join(__dirname, "mock-provider.cjs"), "dist/worker.cjs"],
    { env, stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = once(child, "exit");
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  let id = 0;
  async function call(method, input) {
    child.stdin.write(JSON.stringify({ id: ++id, method, input }) + "\n");
    const next = await lines.next();
    assert.equal(next.done, false);
    const res = JSON.parse(next.value);
    assert.equal(res.id, id);
    if (res.error) throw Error(res.error);
    return res.value;
  }
  const price = {
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 4,
    cacheReadCostPerMillionTokens: 0.5,
  };
  await call("save", {
    patch: {
      usagePriceOverrides: { "matched-model": price },
      usageModelAliases: { "fixture-model": "matched-model" },
    },
  });
  const summary = await call("summary", {
    sinceDay: today.slice(0, 10),
    untilDay: today.slice(0, 10),
    timeZone: "UTC",
    awaitRefresh: true,
  });
  const fallbackDay = "2026-11-01";
  const sinceTime = "2026-11-01T04:00:00.000Z"; // Midnight in New York.
  const untilTime = "2026-11-02T04:30:00.000Z"; // 11:30 PM after the clocks turn back.
  const times = ["2026-11-01T03:59:59.999Z", sinceTime, "2026-11-02T04:29:59.999Z", untilTime];
  const fixture = path.join(env.CLAUDE_CONFIG_DIR, "projects", "test", "clock-change.jsonl");
  await fs.writeFile(fixture, times.map((timestamp, i) => JSON.stringify({
    ...record, timestamp, requestId: "clock-" + i,
    message: { ...record.message, id: "clock-" + i, model: "clock-model" },
  })).join("\n") + "\n");
  const clockDay = await call("summary", {
    sinceDay: fallbackDay, untilDay: fallbackDay, sinceTime, untilTime,
    timeZone: "America/New_York", resolution: "hour", awaitRefresh: true,
  });
  assert.deepEqual(clockDay.buckets.filter((row) => row.model === "clock-model")
    .map((row) => [row.hourStart, row.records]).sort(), [
    [sinceTime, 1], ["2026-11-02T04:00:00.000Z", 1],
  ]);
  const bucket = summary.buckets.find((b) => b.model === "matched-model");
  assert.ok(bucket, "model matched");
  assert.equal(bucket.records, 1);
  assert.equal(bucket.totals.outputTokens, 500000);
  assert.equal(bucket.costUsd, 4.5);
  assert.equal(bucket.sessions, 1);
  // A later T3 scan can recover usage that is absent from an existing ModelGauge cache.
  const timestamp = Date.parse(today);
  const retained = {
    p: "claude", s: 1, m: timestamp, t: [], mr: 0, o: 1, gl: 0, gh: 0, cs: null,
    r: [[timestamp, 0, 0, 1000000, 0, 0, 0, 0, "retained-turn", null, 0]],
  };
  const historyFile = path.join(env.T3CODE_HOME, "userdata", "usage-scan-cache-v17.json");
  const project = await fs.realpath(path.dirname(fixture));
  const history = JSON.stringify({
    version: 17, models: ["fixture-model"], sessions: ["retained-session"],
    files: {
      [path.join(project, "already-deleted.jsonl")]: retained,
      [path.join(project, "conversation.jsonl")]: retained,
    },
  });
  await fs.writeFile(historyFile, history);
  for (let refresh = 0; refresh < 2; refresh++) {
    const updated = await call("summary", {
      sinceDay: today.slice(0, 10), untilDay: today.slice(0, 10), timeZone: "UTC", awaitRefresh: true,
    });
    const row = updated.buckets.find((b) => b.model === "matched-model");
    assert.equal(row.sessions, 2, "recover the deleted session once and preserve the local session");
    assert.equal(row.costUsd, 6.5);
  }
  assert.equal(await fs.readFile(historyFile, "utf8"), history);
  await assert.rejects(
    call("save", { patch: { usagePriceOverrides: { bad: {} } } }),
    /Invalid model price/,
  );
  await assert.rejects(
    call("save", {
      patch: { usageModelAliases: { "matched-model": "fixture-model" } },
    }),
    /cycle/,
  );
  assert.deepEqual(
    (await call("prices")).usagePriceOverrides["matched-model"],
    price,
  );
  assert.equal(await fs.readFile(t3Settings, "utf8"), original);
  await assert.rejects(
    call("reset", { instanceId: "codex", creditId: "sample" }),
    /Refresh/,
  );
  const limits = async () =>
    (await call("limits")).providers.find((p) => p.driver === "codex")
      .usageLimits;
  assert.equal((await limits()).resetCredits.availableCount, 1);
  await assert.rejects(
    call("reset", { instanceId: "codex", creditId: "typo" }),
    /Refresh/,
  );
  assert.deepEqual(
    await call("reset", { instanceId: "codex", creditId: "sample" }),
    { outcome: "reset" },
  );
  assert.equal((await limits()).resetCredits.availableCount, 0);
  await assert.rejects(
    call("reset", { instanceId: "codex", creditId: "sample" }),
    /Refresh/,
  );
  child.stdin.end();
  assert.equal((await exited)[0], 0);
});
