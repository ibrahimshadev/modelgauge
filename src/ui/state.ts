import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import {
  USAGE_CONTRACT_VERSION,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";

export const appAtomRegistry = AtomRegistry.make();
const presentationAtom = Atom.make(new Map()).pipe(Atom.keepAlive);
export const environmentPresentations = {
  presentationsAtom: presentationAtom,
  presentationsWithProvidersAtom: presentationAtom,
};
const summaries = Atom.make(new Map()).pipe(Atom.keepAlive);
let currentWindow;
const latest = new Map();
const inFlight = new Map();
function patch(id, update) {
  const before = appAtomRegistry.get(presentationAtom);
  if (!before.has(id)) return;
  appAtomRegistry.set(
    presentationAtom,
    new Map(before).set(id, { ...before.get(id), ...update }),
  );
}
function setSummary(id, row) {
  appAtomRegistry.set(
    summaries,
    new Map(appAtomRegistry.get(summaries)).set(id, row),
  );
}
export async function initialize() {
  const envs = await window.gauge.environments();
  appAtomRegistry.set(
    presentationAtom,
    new Map(
      envs.map(({ id, label }) => [
        id,
        {
          entry: { target: { label } },
          connection: { phase: "connected" },
          settings: null,
          limitsReady: false,
          serverConfig: {
            environment: { capabilities: { usageModelAliases: true } },
            providers: [],
            usageLimitSources: [],
          },
        },
      ]),
    ),
  );
  await Promise.allSettled(
    envs.map(async ({ id }) =>
      patch(id, { settings: await window.gauge.request(id, "prices") }),
    ),
  );
}
async function scan(id, input, force = false) {
  const key = JSON.stringify([id, input, force]);
  if (inFlight.has(key)) return inFlight.get(key);
  latest.set(id, key);
  const former = appAtomRegistry.get(summaries).get(id);
  const same = former?.windowKey === JSON.stringify(input);
  setSummary(id, {
    windowKey: JSON.stringify(input),
    summary: same ? former.summary : null,
    isPending: true,
    error: null,
  });
  const job = window.gauge
    .request(id, "summary", { ...input, awaitRefresh: force })
    .then((summary) => {
      if (latest.get(id) === key)
        setSummary(id, {
          windowKey: JSON.stringify(input),
          summary,
          isPending: false,
          error: null,
        });
    })
    .catch((error) => {
      if (latest.get(id) === key)
        setSummary(id, {
          windowKey: JSON.stringify(input),
          summary: same ? former.summary : null,
          isPending: false,
          error: error.message,
        });
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
export function mergeAnsweredUsage(environments, keepBucket?, keepProvider?) {
  const answered = environments
    .filter((e) => e.summary)
    .map((e) => ({
      ...e,
      summary: keepBucket || keepProvider
        ? {
            ...e.summary,
            buckets: e.summary.buckets.filter(
              (bucket) => (!keepProvider || keepProvider(bucket.provider)) && (!keepBucket || keepBucket(bucket)),
            ),
            // Fingerprints identify providers and paths. Only buckets carry a model.
            sources: keepProvider
              ? e.summary.sources.filter((source) => keepProvider(source.fingerprint.provider))
              : e.summary.sources,
          }
        : e.summary,
    }));
  return mergeUsage(answered, USAGE_CONTRACT_VERSION);
}
export function useUsage(input, selectedIds, hidden) {
  const presentations = useAtomValue(presentationAtom),
    rows = useAtomValue(summaries);
  const windowKey = JSON.stringify(input);
  const ids = [...presentations.keys()].filter(
    (id) => selectedIds === null || selectedIds.has(id),
  );
  const idsKey = JSON.stringify(ids);
  useEffect(() => {
    currentWindow = input;
    for (const id of ids) void scan(id, input);
  }, [windowKey, idsKey]);
  const environments = [...presentations].map(([id, e]) => {
    const row = rows.get(id);
    return {
      environmentId: id,
      label: e.entry.target.label,
      isConnected: true,
      canReadDiagnostics: !row?.error || Boolean(row?.summary),
      isPending: !row || row.isPending,
      error: row?.error ?? null,
      summary: row?.windowKey === windowKey ? row.summary : null,
    };
  });
  const selectedEnvironments = environments.filter((e) =>
    ids.includes(e.environmentId),
  );
  const merged = mergeAnsweredUsage(
    selectedEnvironments,
    undefined,
    hidden.size ? (provider) => !hidden.has(provider) : undefined,
  );
  return {
    merged,
    environments,
    selectedEnvironments,
    isPartial: selectedEnvironments.some((e) => e.isPending),
    shown: selectedEnvironments.some((e) => e.summary || e.error)
      ? { window: input, merged }
      : null,
    refresh: (next = input) =>
      Promise.all(ids.map((id) => scan(id, next, true))),
  };
}
export async function settlePromise(fn) {
  try {
    return AsyncResult.success(await fn());
  } catch (error) {
    return AsyncResult.failure(Cause.die(error));
  }
}
const limitTimes = new Map();
export async function refreshUsageLimits(id, refresh, automatic) {
  if (automatic && Date.now() - (limitTimes.get(id) || 0) < 300000) return;
  limitTimes.set(id, Date.now());
  await refresh();
}
export const serverEnvironment = {
  refreshProviders: async ({ environmentId: id }) => {
    const result = await window.gauge
      .request(id, "limits")
      .catch(() => ({
        providers: [],
        sources: [
          {
            id: "worker",
            label: "Environment",
            kind: "cliproxyApi",
            checkedAt: new Date().toISOString(),
            accounts: [],
            error: "Could not connect to the environment. Refresh to retry.",
          },
        ],
      }));
    const p = appAtomRegistry.get(presentationAtom).get(id);
    patch(id, {
      limitsReady: true,
      serverConfig: {
        ...p.serverConfig,
        providers: result.providers ?? result,
        usageLimitSources: result.sources ?? [],
      },
    });
  },
  updateSettings: async ({ environmentId: id, input }) => {
    const settings = await window.gauge.request(id, "save", input);
    patch(id, { settings });
    if (currentWindow) await scan(id, currentWindow, true);
    return { _tag: "Success" };
  },
  consumeResetCredit: async ({ environmentId: id, input }) => {
    try {
      const value = await window.gauge.request(id, "reset", input);
      await serverEnvironment.refreshProviders({ environmentId: id });
      return { _tag: "Success", value };
    } catch (error) {
      return { _tag: "Failure", cause: { error } };
    }
  },
};
export const usePrimarySettings = (selector) =>
  selector({ timestampFormat: "locale" });
export const providerClients = new Map(
  Object.entries(PROVIDER_DISPLAY_NAMES).map(([key, label]) => [
    key,
    { label },
  ]),
);
export const normalizeProviderAccentColor = (c) =>
  typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
export const ensureLocalApi = () => ({
  shell: { openExternal: (url) => window.gauge.openExternal(url) },
});
export const getLocalStorageItem = (key, schema) =>
  localStorage.getItem(key) === null
    ? null
    : Schema.decodeUnknownSync(schema)(JSON.parse(localStorage.getItem(key)));
export const setLocalStorageItem = (key, value, schema) =>
  localStorage.setItem(
    key,
    JSON.stringify(Schema.decodeUnknownSync(schema)(value)),
  );
const shortcuts = {
  "usage.cost": "C",
  "usage.tokens": "T",
  "usage.limits": "L",
  "usage.period.day": "1",
  "usage.period.week": "2",
  "usage.period.month": "3",
  "usage.period.quarter": "4",
};
export function shortcutLabelForCommand(_, command) {
  const key = shortcuts[command];
  return /\d/.test(key) ? "Ctrl+Shift+" + key : key;
}
export function resolveShortcutCommand(e) {
  const key = e.code?.startsWith("Digit")
    ? e.code.slice(-1)
    : e.key.toUpperCase();
  return Object.keys(shortcuts).find(
    (cmd) =>
      shortcuts[cmd] === key &&
      (/\d/.test(key)
        ? (e.ctrlKey || e.metaKey) && e.shiftKey
        : !e.ctrlKey && !e.metaKey && !e.altKey),
  );
}
