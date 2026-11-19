// Pin each offline runtime to the checksum published for this Node release.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";

const version = "24.16.0";
const platforms = {
  "x86_64-pc-windows-msvc": [
    "win-x64.zip",
    "edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56",
  ],
  "aarch64-pc-windows-msvc": [
    "win-arm64.zip",
    "14834611d4c6b3c06054e7007732b90474c16e0b32f395e05b55a571ef71c6d2",
  ],
  "x86_64-unknown-linux-gnu": [
    "linux-x64.tar.xz",
    "d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9",
  ],
  "aarch64-unknown-linux-gnu": [
    "linux-arm64.tar.xz",
    "524659219d6a207a7400f2bde15d19ba060ffbe0d32a8643319ad67e3bb64c78",
  ],
  "aarch64-apple-darwin": [
    "darwin-arm64.tar.gz",
    "39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6",
  ],
  "x86_64-apple-darwin": [
    "darwin-x64.tar.gz",
    "298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185",
  ],
};
const target =
  process.argv[2] ||
  process.env.MODELGAUGE_TARGET ||
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .match(/^host: (.+)$/m)[1]
    .trim();
const cache = path.resolve("dist/runtime");
mkdirSync(cache, { recursive: true });
async function stage(triple, output) {
  if (!platforms[triple]) throw Error("Unsupported desktop target: " + triple);
  const [suffix, checksum] = platforms[triple];
  const name = "node-v" + version + "-" + suffix;
  const archive = path.join(cache, name);
  const tmp = mkdtempSync(path.join(cache, "stage-"));
  try {
    if (!existsSync(archive)) {
      const response = await fetch(
        "https://nodejs.org/dist/v" + version + "/" + name,
      );
      if (!response.ok) throw Error("Node download failed: " + response.status);
      await pipeline(response.body, createWriteStream(path.join(tmp, name)));
      renameSync(path.join(tmp, name), archive);
    }
    const hash = createHash("sha256");
    await pipeline(createReadStream(archive), hash);
    if (hash.digest("hex") !== checksum) {
      rmSync(archive);
      throw Error("Node checksum mismatch: " + name);
    }
    const dir = name.replace(/\.(tar\.(xz|gz)|zip)$/, "");
    const binary = suffix.startsWith("win-") ? "node.exe" : "bin/node";
    if (name.endsWith(".zip") && process.platform !== "win32") {
      execFileSync("unzip", [
        "-q",
        archive,
        dir + "/" + binary,
        dir + "/LICENSE",
        "-d",
        tmp,
      ]);
    } else {
      execFileSync("tar", [
        "-xf",
        archive,
        "-C",
        tmp,
        dir + "/" + binary,
        dir + "/LICENSE",
      ]);
    }
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(path.join(tmp, dir, binary), output);
    chmodSync(output, 0o755);
    copyFileSync(
      path.join(tmp, dir, "LICENSE"),
      path.join(cache, "LICENSE-Node"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
const windows = target.endsWith("-windows-msvc");
await stage(
  target,
  "src-tauri/binaries/modelgauge-node-" + target + (windows ? ".exe" : ""),
);
if (windows)
  await stage(target.split("-")[0] + "-unknown-linux-gnu", "dist/wsl/node");
