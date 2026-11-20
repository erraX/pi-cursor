/**
 * The entry Pi loads (`pi.extensions` in package.json).
 *
 * It loads the bundled build when there is one: npm installs ship `dist/`, and `yarn build`
 * makes it in a development clone. A `pi install git:` checkout has no build, because Pi installs
 * packages without dev dependencies and so without tsup; there it loads the TypeScript source.
 *
 * This file must stay TypeScript. Pi runs `.ts` extensions through jiti, which also resolves the
 * source's `./x.js` imports to `./x.ts`. A `.js` entry is handed to Node's own loader instead, and
 * Node does not map those imports, so the source fails to load from it.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The module to load, given whether `dist/index.js` exists next to this file. */
export function extensionEntry(
  builtExists = () => existsSync(fileURLToPath(new URL("./dist/index.js", import.meta.url))),
): "./dist/index.js" | "./src/index.js" {
  return builtExists() ? "./dist/index.js" : "./src/index.js";
}

export default async function piCursor(pi: ExtensionAPI): Promise<void> {
  const entry = extensionEntry();
  const loaded = (await import(entry)) as { default: (pi: ExtensionAPI) => unknown };
  await loaded.default(pi);
}
