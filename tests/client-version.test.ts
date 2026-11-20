import { afterEach, describe, expect, it } from "vitest";

import { getCursorClientVersion } from "../src/config/index.js";

afterEach(() => {
  delete process.env.PI_CURSOR_CLIENT_VERSION;
});

describe("x-cursor-client-version", () => {
  it("announces the Cursor CLI build whose schema agent.proto follows", () => {
    // proto/agent.proto names its newer fields from the Cursor CLI 2026.10.22 bundle, and the
    // service gates protocol features on this header, so the two move together.
    expect(getCursorClientVersion()).toBe("cli-2026.10.22-27dcf5f");
  });

  it("lets PI_CURSOR_CLIENT_VERSION pin another build", () => {
    process.env.PI_CURSOR_CLIENT_VERSION = " cli-2026.07.23-e383d2b ";
    expect(getCursorClientVersion()).toBe("cli-2026.07.23-e383d2b");
  });
});
