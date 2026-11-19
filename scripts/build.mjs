import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = process.cwd();
const vendor = path.resolve("vendor/t3");
const apps = path.join(vendor, "apps");
const packages = path.join(vendor, "packages");
const alias = {
  "@gauge": path.resolve("src/ui"),
  "@t3tools/client-runtime/state/usage-progress": path.join(
    packages,
    "client-runtime/src/state/usageProgress.ts",
  ),
  "@t3tools/contracts": path.resolve("src/report/contracts.ts"),
  "@t3tools/shared": path.join(packages, "shared/src"),
  "@t3tools/provider-core/server": path.join(
    packages,
    "provider-core/src/server",
  ),
  "@server": path.join(apps, "server/src"),
  "@modelgauge": path.resolve("src/report"),
  "~": path.join(apps, "web/src"),
};
for (const provider of ["grok", "pi", "muse", "opencode", "cursor"]) {
  alias["@provider/" + provider] = path.join(
    packages,
    "provider-" + provider,
    "src/server",
  );
}
const common = {
  bundle: true,
  logLevel: "info",
  alias,
  legalComments: "eof",
  jsx: "automatic",
  target: "es2023",
};
await build({
  ...common,
  platform: "node",
  format: "cjs",
  entryPoints: ["src/report/worker.ts"],
  outfile: "dist/worker.cjs",
  minifyWhitespace: true,
});
if (process.argv.includes("--worker")) process.exit(0);
await build({
  ...common,
  platform: "browser",
  format: "iife",
  entryPoints: ["src/ui/index.tsx"],
  outfile: "dist/ui/app.js",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
mkdirSync("dist/ui", { recursive: true });
cpSync("src/ui/index.html", "dist/ui/index.html");
// The stylesheet references Inter by relative URL, as T3's web build does.
const fonts = "node_modules/@fontsource-variable/inter/files";
mkdirSync("dist/ui/files", { recursive: true });
for (const file of readdirSync(fonts)) {
  if (file.endsWith("-wght-normal.woff2"))
    cpSync(path.join(fonts, file), path.join("dist/ui/files", file));
}
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/@tailwindcss/cli/dist/index.mjs"),
    "-i",
    "src/ui/styles.css",
    "-o",
    "dist/ui/app.css",
    "--minify",
  ],
  { stdio: "inherit" },
);
