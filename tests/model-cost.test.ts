import { describe, expect, it } from "vitest";

import { DEFAULT_COST, estimateModelCost } from "../src/models/cost.js";

/** [input, output, cacheRead] in USD per million tokens, as Cursor's model docs list them. */
function price(id: string): [number, number, number] {
  const cost = estimateModelCost(id);
  return [cost.input, cost.output, cost.cacheRead];
}

describe("model cost estimates", () => {
  // Ids are the ones Pi shows for a live catalog (collapsed effort, max-mode and fast suffixes).
  it.each([
    ["kimi-k3", [3, 15, 0.3]],
    ["kimi-k3-max", [3, 15, 0.3]],
    ["kimi-k2.7-code", [0.95, 4, 0.19]],
    ["deepseek-v41-flash-1017", [0.3, 1.2, 0.006]],
    ["deepseek-v41-flash-1017-max-mode", [0.3, 1.2, 0.006]],
    ["glm-5p3-flash", [0.15, 0.5, 0.029]],
    ["glm-5p3-flash-max", [0.15, 0.5, 0.029]],
    ["glm-5p3", [1.4, 4.4, 0.26]],
    ["glm-5p3-max", [1.4, 4.4, 0.26]],
    ["glm-5.2", [1.4, 4.4, 0.26]],
    ["glm-5.2-max", [1.4, 4.4, 0.26]],
    ["composer-2.5", [0.5, 2.5, 0.2]],
    ["composer-2.5-max-mode", [0.5, 2.5, 0.2]],
  ] as const)("prices %s from Cursor's model page", (id, expected) => {
    expect(price(id)).toEqual(expected);
  });

  it.each([
    ["composer-2.5-fast", [3, 15, 0.5]],
    ["composer-2.5-max-mode-fast", [3, 15, 0.5]],
    ["grok-4.7", [2, 6, 0.5]],
    ["grok-4.7-256k-max-mode", [2, 6, 0.5]],
    ["grok-4.7-fast", [4, 12, 1]],
    ["grok-4.7-256k-fast", [4, 12, 1]],
    ["grok-4.7-500k-max-mode", [4, 12, 1]],
    ["grok-4.7-500k-max-mode-fast", [6, 18, 1.5]],
    ["cursor-grok-4.6", [2, 6, 0.5]],
    ["cursor-grok-4.6-fast", [4, 12, 1]],
    ["cursor-grok-4.5", [2, 6, 0.5]],
    ["cursor-grok-4.5-fast", [4, 18, 1]],
  ] as const)("prices the fast and long-context tier of %s", (id, expected) => {
    expect(price(id)).toEqual(expected);
  });

  it("leaves the families that were already priced alone", () => {
    expect(price("composer-1")).toEqual([1.25, 10, 0.125]);
    expect(price("composer-2-fast")).toEqual([0.5, 2.5, 0.2]);
    expect(price("grok-4.20")).toEqual([2, 6, 0.2]);
    expect(price("kimi-k2.5")).toEqual([0.6, 3, 0.1]);
    expect(price("claude-4.6-sonnet")).toEqual([3, 15, 0.3]);
    expect(estimateModelCost("some-unknown-model")).toBe(DEFAULT_COST);
  });
});
