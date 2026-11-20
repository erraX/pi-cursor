/**
 * Keeps the suite out of the developer's real cache directory.
 *
 * The lifecycle log and the run journal are always on, and they resolve their directory through
 * `getCacheDir()`: `PI_CURSOR_CACHE_DIR`, then `$XDG_CACHE_HOME/pi-cursor`, then
 * `~/.cache/pi-cursor`. A test that never sets the first one therefore wrote fake stream events
 * (`local_tool_loop_stopped`, stranding `wire_drift`, ...) next to the logs of real sessions.
 *
 * Tests that need their own directory set and later delete `PI_CURSOR_CACHE_DIR`, so the
 * isolation rides on `XDG_CACHE_HOME`, the fallback that deletion lands on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

const isolatedCacheHome = mkdtempSync(join(tmpdir(), "pi-cursor-test-cache-"));
process.env.XDG_CACHE_HOME = isolatedCacheHome;
// A value exported in the developer's shell would win over XDG_CACHE_HOME.
delete process.env.PI_CURSOR_CACHE_DIR;

afterAll(() => {
  // The lifecycle log appends asynchronously and can land mid-removal (ENOTEMPTY).
  rmSync(isolatedCacheHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
