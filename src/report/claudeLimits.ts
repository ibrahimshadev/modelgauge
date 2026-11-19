// Claude's control channel returns the same get_usage response T3 consumes. No user turn is sent.
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { claudeUsageResponseToLimits } from "@server/provider/claudeUsageLimits";
import { claudeResetCreditsToContract } from "@server/provider/claudeResetCredits";

export async function readClaudeCli(profile) {
  const { config, env } = profile;
  const initId = randomUUID(),
    usageId = randomUUID();
  const nativeInstall = path.join(
    homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  const child = spawn(
    config.binaryPath || (existsSync(nativeInstall) ? nativeInstall : "claude"),
    [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--settings",
      '{"disableAllHooks":true}',
      "--strict-mcp-config",
      "--tools",
      "",
    ],
    {
      cwd: homedir(),
      env: {
        ...env,
        ...(config.homePath ? { CLAUDE_CONFIG_DIR: config.homePath } : {}),
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const send = (id, subtype) =>
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: id,
        request: { subtype },
      }) + "\n",
    );
  let account, version;
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(Error("Claude usage probe timed out."));
        child.kill();
      }, 20000);
      const lines = createInterface({ input: child.stdout });
      child.once("error", reject);
      child.stdin.on("error", reject);
      child.once("close", () => {
        clearTimeout(timeout);
        reject(Error("Claude usage probe closed."));
      });
      lines.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type !== "control_response") return;
          const { response, subtype, request_id } = msg.response;
          if (subtype !== "success")
            throw Error("Claude could not report usage.");
          if (request_id === initId) {
            account = response.account;
            version = response.claude_code_version;
            send(usageId, "get_usage");
            return;
          }
          if (request_id !== usageId) return;
          const { limits } = claudeUsageResponseToLimits({
            response,
            checkedAt: new Date().toISOString(),
          });
          const credits =
            process.platform === "darwin"
              ? undefined
              : claudeResetCreditsToContract(
                  response.rate_limits?.cedar_ember,
                  Date.now(),
                );
          resolve({
            usageLimits: credits
              ? { ...limits, resetCredits: credits }
              : limits,
            plan: response.subscription_type,
            email: account?.email,
            version,
          });
        } catch (err) {
          reject(err);
        }
      });
      send(initId, "initialize");
    });
  } finally {
    child.stdin.end();
    child.kill();
  }
}
