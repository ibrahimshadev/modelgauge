// Providers throttle their usage endpoints. Keep each account's last good limits so a
// refused probe still shows them, and wait out the provider's Retry-After before asking again.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { baseDir } from "./host";
import { PROVIDER_DISPLAY_NAMES } from "./contracts";

const file = path.join(baseDir, "limits-memory.json");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WAIT_SECONDS = 300;

/** A provider answered but would not report limits. `retryAfterSeconds` starts a wait. */
export class ProbeRefused extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Seconds from a Retry-After header, which is either a delay or an HTTP date. */
export function retryAfterSeconds(header: string | null, now = Date.now()) {
  if (!header) return DEFAULT_WAIT_SECONDS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? DEFAULT_WAIT_SECONDS : (date - now) / 1000;
}

type Entry = { row?: any; retryAt?: number };
let memory: Promise<Record<string, Entry>> | undefined;
let writes = Promise.resolve();

function load() {
  memory ??= readFile(file, "utf8").then(
    (text) => {
      try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    },
    () => ({}),
  );
  return memory;
}

function save(entries: Record<string, Entry>) {
  const text = JSON.stringify(entries);
  writes = writes
    .then(async () => {
      await mkdir(baseDir, { recursive: true, mode: 0o700 });
      const tmp = file + "." + randomUUID();
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, file);
    })
    // Remembered limits are a convenience; a read-only data directory must not fail the probe.
    .catch(() => {});
}

function ago(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  return hours + (hours === 1 ? " hour ago" : " hours ago");
}

// The Limits view draws no bars for an account marked unavailable, so remembered limits
// travel as a normal row and the reason travels beside it as a notice.
function remembered(p, entry: Entry, now: number, reason: string) {
  const name = p.label || PROVIDER_DISPLAY_NAMES[p.driver] || p.driver;
  const wait =
    entry.retryAt && entry.retryAt > now
      ? " Next check in " + Math.ceil((entry.retryAt - now) / 60000) + " min."
      : "";
  const limits = entry.row?.usageLimits;
  const age = limits ? now - Date.parse(limits.checkedAt) : Infinity;
  // A window that has reset since the last good read no longer describes the account.
  const windows = (limits?.windows ?? []).filter(
    (w) => !w.resetsAt || Date.parse(w.resetsAt) > now,
  );
  if (!(age <= MAX_AGE_MS) || windows.length === 0)
    return {
      row: {
        instanceId: p.id,
        driver: p.driver,
        displayName: name,
        enabled: true,
        installed: true,
        auth: { status: "unknown" },
        usageLimits: {
          windows: [],
          checkedAt: new Date(now).toISOString(),
          unavailable: { reason: "probeFailed", message: reason + wait },
        },
      },
    };
  // Redeeming needs a fresh read, so remembered limits never offer a reset.
  const { resetCredits: _, ...rest } = limits;
  return {
    row: { ...entry.row, usageLimits: { ...rest, windows } },
    notice: {
      label: name,
      message: reason + " Showing limits from " + ago(age) + "." + wait,
    },
  };
}

/**
 * Runs `probe` unless the provider asked us to wait, falling back to remembered limits.
 * Returns the account row, plus a notice when the row is not a fresh read.
 */
export async function withMemory(
  p,
  probe: () => Promise<any>,
  now = Date.now(),
): Promise<{ row?: any; notice?: { label: string; message: string } }> {
  const entries = await load();
  const entry = entries[p.id] ?? {};
  if (entry.retryAt && entry.retryAt > now)
    return remembered(p, entry, now, "The provider is rate-limiting usage checks.");
  let row;
  try {
    row = await probe();
  } catch (error) {
    const refused = error instanceof ProbeRefused;
    if (refused && error.retryAfterSeconds !== undefined) {
      const seconds = Math.min(1800, Math.max(60, error.retryAfterSeconds));
      entries[p.id] = { ...entry, retryAt: now + seconds * 1000 };
      save(entries);
    }
    return remembered(
      p,
      entries[p.id] ?? entry,
      now,
      refused ? error.message : "Could not read provider limits.",
    );
  }
  if (!row) {
    if (entries[p.id]) {
      delete entries[p.id];
      save(entries);
    }
    return {};
  }
  const limits = row.usageLimits;
  if (limits.windows.length > 0 && !limits.unavailable) {
    entries[p.id] = { row };
    save(entries);
    return { row };
  }
  return limits.unavailable?.reason === "probeFailed"
    ? remembered(p, entry, now, limits.unavailable.message ?? "Could not read provider limits.")
    : { row };
}
