import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const version = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
assert.equal(process.versions.node, version, "Use the Node version in .node-version");
const cpu = { x64: "x86_64", arm64: "aarch64" }[process.arch];
const os = { win32: "pc-windows-msvc", linux: "unknown-linux-gnu", darwin: "apple-darwin" }[process.platform];
assert.ok(cpu && os, "Unsupported worker platform");
const target = cpu + "-" + os;
const wsl = "dist/wsl/node";

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

if (process.argv[2] === "--wsl") {
  assert.ok(process.platform === "linux" && process.report.getReport().header.glibcVersionRuntime,
    "Stage the WSL worker from a glibc Linux host");
  mkdirSync(path.dirname(wsl), { recursive: true });
  copyFileSync(process.execPath, wsl);
  writeFileSync(wsl + ".json", JSON.stringify({ version, cpu, sha256: await digest(wsl) }));
} else {
  assert.equal(process.env.TAURI_ENV_TARGET_TRIPLE || process.env.MODELGAUGE_TARGET || target,
    target, "Run the build on the target OS and architecture");
  if (process.platform === "win32") {
    const manifest = JSON.parse(readFileSync(wsl + ".json", "utf8"));
    assert.deepEqual(manifest, { version, cpu, sha256: await digest(wsl) },
      "Stage the matching WSL runtime with node scripts/runtimes.mjs --wsl on Linux");
  }
  mkdirSync("src-tauri/binaries", { recursive: true });
  const suffix = process.platform === "win32" ? ".exe" : "";
  copyFileSync(process.execPath, "src-tauri/binaries/modelgauge-node-" + target + suffix);
}
