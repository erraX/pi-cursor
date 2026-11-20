import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extensionEntry } from "../extension.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  pi: { extensions: string[] };
  files: string[];
};

describe("Pi extension entry", () => {
  it("is the entry Pi loads, and ships in the npm package", () => {
    expect(manifest.pi.extensions).toEqual(["./extension.js"]);
    expect(manifest.files).toContain("extension.js");
  });

  it("loads the bundled build when there is one", () => {
    expect(extensionEntry(() => true)).toBe("./dist/index.js");
  });

  it("loads the TypeScript source when there is no build", () => {
    // A `pi install git:` checkout: Pi installs without dev dependencies, so nothing builds it.
    expect(extensionEntry(() => false)).toBe("./src/index.ts");
  });
});
