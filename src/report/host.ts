import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const baseDir =
  process.env.MODELGAUGE_HOME ||
  (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || homedir(), "ModelGauge", "data")
    : process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "ModelGauge")
      : path.join(
          process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"),
          "modelgauge",
        ));
export const ServerConfig = Context.Reference("modelgauge/paths", {
  defaultValue: () => ({ baseDir, stateDir: baseDir }),
});
export const t3StateDir = path.join(
  process.env.T3CODE_HOME || path.join(homedir(), ".t3"),
  "userdata",
);
export const managedAntigravityHome = (id) =>
  path.join(
    t3StateDir,
    "providers",
    "antigravity",
    createHash("sha256").update(id).digest("hex"),
  );
export async function cursorCredential(id) {
  const key = createHash("sha256")
    .update("6:cursor" + id)
    .digest("hex");
  const auth = await jsonFile(
    path.join(t3StateDir, "secrets", "provider-auth-" + key + ".bin"),
  );
  return auth.version === 1 &&
    (!auth.apiKeyExpiresAtMs || auth.apiKeyExpiresAtMs > Date.now())
    ? auth
    : {};
}
export const readStoredCursorApiKey = (id) =>
  Effect.tryPromise(async () => (await cursorCredential(id)).apiKey);
const settingsPath = path.join(baseDir, "settings.json");
async function jsonFile(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
export async function settings() {
  const local = await jsonFile(settingsPath);
  const t3 = await jsonFile(path.join(t3StateDir, "settings.json"));
  return {
    providerInstances: { ...t3.providerInstances, ...local.providerInstances },
    usageLimitSources: { ...t3.usageLimitSources, ...local.usageLimitSources },
    usageModelFilter: local.usageModelFilter ?? t3.usageModelFilter,
    usageHistoryRetentionDays:
      local.usageHistoryRetentionDays ?? t3.usageHistoryRetentionDays ?? 92,
    usagePriceOverrides:
      local.usagePriceOverrides ?? t3.usagePriceOverrides ?? {},
    usageModelAliases: local.usageModelAliases ?? t3.usageModelAliases ?? {},
  };
}
export const ServerSettingsService = Context.Reference("modelgauge/settings", {
  defaultValue: () => ({
    getSettings: Effect.tryPromise(settings),
    withSettingsSnapshot: (use) =>
      Effect.flatMap(Effect.tryPromise(settings), use),
  }),
});
export async function savePrices(prices, aliases) {
  const tmp = settingsPath + "." + randomUUID();
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  await writeFile(
    tmp,
    JSON.stringify(
      {
        ...(await jsonFile(settingsPath)),
        usagePriceOverrides: prices,
        usageModelAliases: aliases,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await rename(tmp, settingsPath);
}
