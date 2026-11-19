import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { UsageSummaryInput } from "./contracts";
import * as Usage from "@server/usage/UsageService";
import * as Antigravity from "@server/provider/Drivers/AntigravityUsage";
import { baseDir, t3StateDir, settings, savePrices } from "./host";
import { existsSync, constants } from "node:fs";
import path from "node:path";
import * as CodexHistory from "@server/usage/CodexUsageHistory";
import * as Sqlite from "@t3tools/shared/nodeSqliteClient";
import * as MuseHome from "@provider/muse/MuseUsageHome";
import * as CursorAccounts from "@provider/cursor/CursorUsageAccounts";
import * as CursorReader from "@provider/cursor/CursorAccountReader";
import { copyFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { probeLimits, resetCredit } from "./limits";

const platform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  NodeCrypto.layer,
  FetchHttpClient.layer,
);
const database = path.join(t3StateDir, "statev2.sqlite");
const history = existsSync(database)
  ? CodexHistory.layer.pipe(
      Layer.provide(Sqlite.layer({ filename: database, readonly: true })),
    )
  : Layer.succeed(CodexHistory.CodexUsageHistory)({
      resolve: () => Effect.succeed(new Map()),
    });
const cursor = CursorAccounts.layer.pipe(Layer.provide(CursorReader.layer));
const services = Layer.effect(Usage.UsageService, Usage.make).pipe(
  Layer.provideMerge(
    Layer.mergeAll(Antigravity.layer, cursor, history, MuseHome.layer).pipe(
      Layer.provideMerge(platform),
    ),
  ),
);
const runtime = ManagedRuntime.make(services);
const run = (program) => runtime.runPromise(program);
async function dispatch(method, input) {
  if (method === "limits") return probeLimits(run);
  if (method === "reset") return resetCredit(input, run);
  const config = await settings();
  if (method === "prices")
    return {
      usagePriceOverrides: config.usagePriceOverrides,
      usageModelAliases: config.usageModelAliases,
    };
  if (method === "save") {
    const { patch } = input;
    const merge = (before, edits) =>
      Object.fromEntries(
        Object.entries({ ...before, ...edits }).filter(([, v]) => v !== null),
      );
    const prices = merge(config.usagePriceOverrides, patch.usagePriceOverrides);
    const aliases = merge(config.usageModelAliases, patch.usageModelAliases);
    for (const [model, rates] of Object.entries(prices)) {
      if (
        !model.trim() ||
        Object.hasOwn(Object.prototype, model) ||
        !rates ||
        typeof rates !== "object" ||
        !Object.hasOwn(rates, "inputCostPerMillionTokens") ||
        !Object.hasOwn(rates, "outputCostPerMillionTokens") ||
        !Object.entries(rates).every(
          ([k, v]) =>
            [
              "inputCostPerMillionTokens",
              "outputCostPerMillionTokens",
              "cacheReadCostPerMillionTokens",
              "cacheWriteCostPerMillionTokens",
            ].includes(k) &&
            Number.isFinite(v) &&
            v >= 0,
        )
      )
        throw Error("Invalid model price");
    }
    for (const [from, to] of Object.entries(aliases)) {
      if (
        !from.trim() ||
        Object.hasOwn(Object.prototype, from) ||
        Object.hasOwn(Object.prototype, to) ||
        typeof to !== "string" ||
        !to.trim()
      )
        throw Error("Invalid model alias");
      const visited = new Set([from]);
      for (let id = to; Object.hasOwn(aliases, id); id = aliases[id]) {
        if (visited.has(id)) throw Error("Model alias cycle");
        visited.add(id);
      }
    }
    await savePrices(prices, aliases);
    return { usagePriceOverrides: prices, usageModelAliases: aliases };
  }
  if (method !== "summary") throw Error("Unknown report request");
  const query = Schema.decodeUnknownSync(UsageSummaryInput)(input);
  return run(
    Effect.flatMap(Usage.UsageService, (service) =>
      service.readSummary({ ...query, modelFilter: config.usageModelFilter }),
    ),
  );
}
async function main() {
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  // Import only existing aggregate caches. Each environment owns subsequent history and edits.
  for (const filename of [
    "usage-model-rates.json",
    "usage-scan-cache-v17.json",
    "usage-cursor-account-cache-v2.json",
  ]) {
    if (existsSync(path.join(baseDir, filename))) continue;
    await copyFile(
      path.join(t3StateDir, filename),
      path.join(baseDir, filename),
      constants.COPYFILE_EXCL,
    ).catch((error) => {
      if (error.code !== "ENOENT" && error.code !== "EEXIST") throw error;
    });
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  let writes = Promise.resolve();
  for await (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, input } = message;
    const result =
      method === "save"
        ? (writes = writes.catch(() => {}).then(() => dispatch(method, input)))
        : dispatch(method, input);
    const task = result
      .then(
        (value) => process.stdout.write(JSON.stringify({ id, value }) + "\n"),
        (error) =>
          process.stdout.write(
            JSON.stringify({
              id,
              error: error.message || "Report request failed",
            }) + "\n",
          ),
      )
      .then(() => {});
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.allSettled(pending);
  await run(
    Effect.flatMap(Usage.UsageService, (service) => service.awaitPersisted),
  );
  await runtime.dispose();
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
