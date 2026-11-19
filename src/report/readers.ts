import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { claudeUsageReader } from "@server/provider/Drivers/claudeUsage";
import { codexUsageReader } from "@server/provider/Drivers/codexUsage";
import { grokUsageReader } from "@provider/grok/usage";
import { piUsageReader } from "@provider/pi/usage";
import { openCodeUsageReader } from "@provider/opencode/usage";
import { museUsageReader } from "@provider/muse/usage";
import { antigravityUsageReader } from "@server/provider/Drivers/AntigravityUsage";
import { cursorRateModel } from "@provider/cursor/accountUsage";

import { CursorUsageAccounts } from "@provider/cursor/CursorUsageAccounts";
const cursorUsageReader = {
  kind: "scan",
  provider: "cursor",
  rateModel: cursorRateModel,
  scan: (input) =>
    Effect.flatMap(CursorUsageAccounts, (accounts) => accounts.scan(input)),
};
const configSchema = Schema.Struct({
  binaryPath: Schema.optional(Schema.String),
  homePath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  launchArgs: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
});
export const BUILT_IN_USAGE_DRIVERS = [
  claudeUsageReader,
  codexUsageReader,
  grokUsageReader,
  piUsageReader,
  openCodeUsageReader,
  museUsageReader,
  antigravityUsageReader,
  cursorUsageReader,
].map((usage) => ({
  driverKind: usage.provider === "claude" ? "claudeAgent" : usage.provider,
  configSchema,
  usage,
}));
