/**
 * Builds `dist/` on install when tsup is installed (a development clone), and otherwise does
 * nothing. `pi install git:` installs without dev dependencies, so there is no tsup there;
 * `extension.ts` then loads the TypeScript source instead. Fetching tsup with npx at install
 * time used to stand in for it, and failed whenever npm could not fetch rollup's native binary.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, "dist/index.js"))) process.exit(0);

const win = process.platform === "win32";
const tsup = join(root, "node_modules", ".bin", win ? "tsup.cmd" : "tsup");
if (!existsSync(tsup)) {
  console.log("pi-cursor: no tsup installed, skipping the build; Pi loads the TypeScript source.");
  process.exit(0);
}
const result = spawnSync(tsup, [], { stdio: "inherit", cwd: root, shell: win });
process.exit(result.status ?? 1);
