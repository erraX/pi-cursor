import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getCacheDir, resetCacheDirForTests } from "../src/utils/cache-dir.js";

describe("test suite cache isolation", () => {
  it("resolves the default cache directory outside the developer's home", () => {
    delete process.env.PI_CURSOR_CACHE_DIR;
    resetCacheDirForTests();
    const dir = resolve(getCacheDir() ?? "");
    resetCacheDirForTests();

    expect(dir.startsWith(resolve(tmpdir()))).toBe(true);
    expect(dir).not.toBe(resolve(join(homedir(), ".cache", "pi-cursor")));
  });
});
