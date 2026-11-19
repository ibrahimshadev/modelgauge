import { makeWindow } from "@t3tools/shared/usageFormat";
import { UsageProviderKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "@gauge/state";

const STORAGE_KEY = "modelgauge:usage:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals(["today", 1, 7, 30, 90]),
  hiddenProviders: Schema.optional(Schema.Array(UsageProviderKind)),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;

const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "cost", windowDays: 7 };

export function makeUsagePageWindow(period: UsagePagePreferences["windowDays"], now = new Date()) {
  if (period !== "today") return makeWindow(period, now, period === 1 ? "hour" : "day");
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // Hourly queries use an exclusive end and require a nonempty interval at midnight.
  const end = new Date(Math.max(start.getTime() + 1, now.getTime()));
  return {
    ...makeWindow(1, now),
    resolution: "hour" as const,
    sinceTime: start.toISOString(),
    untilTime: end.toISOString(),
  };
}

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return getLocalStorageItem(STORAGE_KEY, UsagePagePreferencesSchema) ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    setLocalStorageItem(STORAGE_KEY, preferences, UsagePagePreferencesSchema);
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
