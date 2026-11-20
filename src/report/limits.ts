import { readClaudeCli } from "./claudeLimits";
import * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  makeCliproxyApi,
  HUB_PROVIDERS,
  creditRedeemRequestId,
} from "@server/usage/cliproxyApi";
import {
  claudeResetCreditsToContract,
  consumeClaudeResetCredit,
} from "@server/provider/claudeResetCredits";
import { readGrokAccount } from "@provider/grok/usageLimits";
import { readCursorUsageLimits } from "@provider/cursor/usageLimits";
import { readOpenCodeGoUsageLimits } from "@provider/opencode/usageLimits";
import { existsSync } from "node:fs";
import { makeAntigravityUsageProbe } from "@server/provider/antigravityUsageLimits";
import { settings, managedAntigravityHome, cursorCredential } from "./host";
import { ProbeRefused, retryAfterSeconds, withMemory } from "./limitsMemory";
const exec = promisify(execFile);
const reported = new Map();
const pending = new Set();
const requests = new Map();
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw Error("Account file could not be read");
  }
}
function homePath(value, fallback) {
  const p = value || fallback;
  return p.startsWith("~/") || p.startsWith("~\\")
    ? path.join(homedir(), p.slice(2))
    : p;
}
async function credentials(profile) {
  const { driver, env, config } = profile;
  if (driver === "codex") {
    const dir = homePath(
      config.shadowHomePath || config.homePath || env.CODEX_HOME,
      path.join(homedir(), ".codex"),
    );
    const auth = await readJson(path.join(dir, "auth.json"));
    const tokens = auth.tokens;
    if (!tokens?.access_token) return;
    let claims = {};
    try {
      claims = JSON.parse(
        Buffer.from(
          (tokens.id_token || "").split(".")[1],
          "base64url",
        ).toString(),
      );
    } catch {}
    return {
      token: tokens.access_token,
      email: claims.email,
      accountId:
        tokens.account_id ||
        claims["https://api.openai.com/auth"]?.chatgpt_account_id,
    };
  }
  const custom = config.homePath || env.CLAUDE_CONFIG_DIR;
  const dir = homePath(custom, path.join(homedir(), ".claude"));
  const accountConfigPath = custom
    ? path.join(dir, ".claude.json")
    : path.join(homedir(), ".claude.json");
  let auth;
  if (process.platform === "darwin") {
    const suffix = custom
      ? "-" + createHash("sha256").update(dir).digest("hex").slice(0, 8)
      : "";
    try {
      auth = JSON.parse(
        (
          await exec(
            "/usr/bin/security",
            [
              "find-generic-password",
              "-s",
              "Claude Code-credentials" + suffix,
              "-w",
            ],
            { timeout: 4000 },
          )
        ).stdout,
      );
    } catch {
      return;
    }
  } else auth = await readJson(path.join(dir, ".credentials.json"));
  if (!auth.claudeAiOauth?.accessToken) return;
  const info = (await readJson(accountConfigPath)).oauthAccount || {};
  return {
    token: auth.claudeAiOauth.accessToken,
    email: info.emailAddress,
    accountId: info.organizationUuid,
    dir,
    accountConfigPath,
  };
}
async function vendorRequest(url, token, headers = {}, data?) {
  const response = await fetch(url, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...headers,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.status === 429 || response.status === 503)
    throw new ProbeRefused(
      "The provider is rate-limiting usage checks.",
      retryAfterSeconds(response.headers.get("retry-after")),
    );
  if (!response.ok)
    throw new ProbeRefused("Provider returned HTTP " + response.status + ".");
  return response.text();
}
async function profiles() {
  const { providerInstances } = await settings();
  const known = [
    "codex",
    "claudeAgent",
    "grok",
    "cursor",
    "opencode",
    "antigravity",
  ];
  const list = new Map(
    known.map((driver) => [
      driver,
      { id: driver, driver, config: {}, env: process.env },
    ]),
  );
  for (const [id, p] of Object.entries(providerInstances)) {
    if (!known.includes(p.driver)) continue;
    if (p.enabled === false) {
      list.delete(id);
      continue;
    }
    const vars = Object.fromEntries(
      (p.environment || [])
        .filter((v) => typeof v.value === "string")
        .map((v) => [v.name, v.value]),
    );
    list.set(id, {
      id,
      driver: p.driver,
      config: p.config || {},
      env: { ...process.env, ...vars },
      label: p.displayName,
    });
  }
  return [...list.values()];
}
async function readProfile(p, run) {
  const { driver, id, env, config } = p;
  let email, workspaceId, plan, usageLimits;
  if (driver === "codex" || driver === "claudeAgent") {
    const c = await credentials(p);
    const cli =
      driver === "claudeAgent"
        ? await readClaudeCli(p).catch((error) => {
            // The CLI reads the same throttled endpoint, so asking again from here
            // would only extend the provider's wait.
            if (error instanceof ProbeRefused) throw error;
            return undefined;
          })
        : undefined;
    if (cli && !cli.usageLimits.unavailable) {
      const { usageLimits, plan } = cli;
      const identity = c?.accountId || c?.email;
      if (identity && usageLimits.resetCredits?.availableCount > 0)
        reported.set(id, {
          identity,
          credits: usageLimits.resetCredits,
          p,
          version: cli.version,
        });
      else reported.delete(id);
      return {
        instanceId: id,
        driver,
        displayName: p.label,
        enabled: true,
        installed: true,
        auth: {
          status: "authenticated",
          email: cli.email || c?.email,
          workspaceId: c?.accountId,
          label: plan,
        },
        usageLimits,
      };
    }
    if (!c) return;
    email = c.email;
    workspaceId = c.accountId;
    const key = driver === "codex" ? "codex" : "claude";
    const adapter = HUB_PROVIDERS.get(key);
    const account = {
      id,
      provider: key,
      email,
      id_token: { chatgpt_account_id: workspaceId },
    };
    const headers = adapter.header(account, process.platform, process.arch);
    let claudeCredits, refused;
    const call = (url) =>
      Effect.tryPromise(async () => {
        const isClaude =
          key === "claude" &&
          url === "https://api.anthropic.com/api/oauth/usage";
        const raw = await vendorRequest(
          isClaude ? url + "?cedar_ember=1&skip_spend=1" : url,
          c.token,
          headers,
        ).catch((error) => {
          // Effect wraps the rejection; keep the provider's own answer for the report.
          refused = error;
          throw error;
        });
        if (isClaude && process.platform !== "darwin")
          claudeCredits = claudeResetCreditsToContract(
            JSON.parse(raw).cedar_ember,
            Date.now(),
          );
        return raw;
      });
    const result = await run(
      adapter.read({ account, call, checkedAt: new Date().toISOString() }),
    ).catch((error) => {
      throw refused ?? error;
    });
    plan = result.plan;
    usageLimits = result.usageLimits;
    if (claudeCredits)
      usageLimits = { ...usageLimits, resetCredits: claudeCredits };
    const credits = usageLimits.resetCredits;
    if (credits?.availableCount > 0)
      reported.set(id, { identity: workspaceId || email, credits, p });
    else reported.delete(id);
  } else if (driver === "grok") {
    if (
      !env.GROK_AUTH &&
      !existsSync(
        path.join(env.GROK_HOME || path.join(homedir(), ".grok"), "auth.json"),
      )
    )
      return;
    const account = await run(readGrokAccount(env));
    email = account.email;
    usageLimits = account.usageLimits;
  } else if (driver === "cursor") {
    const auth = await cursorCredential(id);
    usageLimits = await run(
      readCursorUsageLimits(config, {
        ...env,
        CURSOR_API_KEY: env.CURSOR_API_KEY || auth.apiKey,
      }),
    );
  } else if (driver === "antigravity") {
    usageLimits = await run(
      Effect.flatMap(
        makeAntigravityUsageProbe({
          profileDirectory: managedAntigravityHome(id),
          authMethod: config.authMethod || "oauth-personal",
        }),
        (a) => a.probe,
      ),
    );
  } else {
    usageLimits = await run(
      readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: config.serverUrl || "",
        environment: env,
      }),
    );
  }
  if (usageLimits.unavailable?.reason === "unsupported") return;
  return {
    instanceId: id,
    driver,
    displayName: p.label,
    enabled: true,
    installed: true,
    auth: { status: "authenticated", email, workspaceId, label: plan },
    usageLimits,
  };
}
const hubs = new Map();
async function readHub(id, config, run) {
  const url = URL.parse(config.url);
  const base = {
    id,
    kind: config.kind,
    label: config.label || url?.host || id,
    checkedAt: new Date().toISOString(),
    origin: url?.origin,
    endpoint:
      url &&
      url.origin + url.pathname.replace(/(\/management\.html)?\/*$/i, ""),
  };
  hubs.delete(id);
  if (typeof config.managementKey !== "string" || !config.managementKey)
    return {
      ...base,
      accounts: [],
      error: "A literal management key is required in this environment.",
    };
  try {
    const accounts = await run(
      Effect.flatMap(makeCliproxyApi, (api) => api.readAccounts(config)),
    );
    hubs.set(id, { url: config.url, accounts });
    return { ...base, accounts };
  } catch (error) {
    return {
      ...base,
      accounts: [],
      error: error.detail || "Could not read hub accounts.",
    };
  }
}
export async function probeLimits(run) {
  const reads = await Promise.all(
    (await profiles()).map(async (p) => ({
      p,
      ...(await withMemory(p, () => readProfile(p, run))),
    })),
  );
  const checkedAt = new Date().toISOString();
  // A source without accounts is how the Limits view carries a message with no bars of its own.
  const notices = reads.flatMap(({ p, notice }) =>
    notice
      ? [
          {
            id: "remembered:" + p.id,
            kind: "cliproxyApi",
            label: notice.label,
            checkedAt,
            accounts: [],
            error: notice.message,
          },
        ]
      : [],
  );
  const { usageLimitSources } = await settings();
  const sources = await Promise.all(
    Object.entries(usageLimitSources)
      .filter(([, c]) => c.enabled)
      .map(([id, c]) => readHub(id, c, run)),
  );
  return {
    providers: reads.flatMap(({ row }) => (row ? [row] : [])),
    sources: [...notices, ...sources],
  };
}
export async function resetCredit(input, run) {
  if (input.sourceId) {
    const config = (await settings()).usageLimitSources[input.sourceId];
    const hub = hubs.get(input.sourceId);
    const account = hub?.accounts.find(
      (a) => a.id === input.accountId && a.driver === "codex",
    );
    if (
      !config?.enabled ||
      hub?.url !== config.url ||
      !account ||
      !input.creditId ||
      account.usageLimits.resetCredits?.nextCreditId !== input.creditId
    )
      throw Error("Refresh the hub account before using a reset.");
    hubs.delete(input.sourceId);
    return run(
      Effect.flatMap(makeCliproxyApi, (api) =>
        api.consume(config, input.accountId, input.creditId),
      ),
    );
  }
  const state = reported.get(input.instanceId);
  const creditId = input.creditId || state?.credits.nextCreditId;
  if (
    !state ||
    !creditId ||
    !state.identity ||
    ![
      state.credits.nextCreditId,
      ...(state.credits.options || []).map((o) => o.creditId),
    ].includes(creditId)
  )
    throw Error("Refresh this account before using a reset.");
  const key = JSON.stringify([state.p.driver, state.identity, creditId]);
  if (pending.has(key)) throw Error("A reset is already in progress.");
  pending.add(key);
  try {
    const c = await credentials(state.p);
    if (!c || (c.accountId || c.email) !== state.identity)
      throw Error("Account changed. Refresh limits.");
    let outcome;
    if (state.p.driver === "codex") {
      const body = await vendorRequest(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        c.token,
        {
          "OpenAI-Beta": "codex-1",
          Originator: "Codex Desktop",
          ...(c.accountId ? { "Chatgpt-Account-Id": c.accountId } : {}),
        },
        {
          credit_id: creditId,
          redeem_request_id: await run(
            creditRedeemRequestId(state.identity, creditId),
          ),
        },
      );
      outcome = {
        reset: "reset",
        nothing_to_reset: "nothingToReset",
        no_credit: "noCredit",
        already_redeemed: "alreadyRedeemed",
      }[JSON.parse(body).code];
    } else {
      const requestId = requests.get(key) || randomUUID();
      requests.set(key, requestId);
      outcome = await run(
        consumeClaudeResetCredit({
          ...c,
          configDir: c.dir,
          version: state.version || "2.1.273",
          requestId,
          grantId: creditId,
        }),
      );
    }
    if (!outcome) throw Error("Provider returned an unknown reset outcome.");
    requests.delete(key);
    reported.delete(input.instanceId);
    return { outcome };
  } finally {
    pending.delete(key);
  }
}
