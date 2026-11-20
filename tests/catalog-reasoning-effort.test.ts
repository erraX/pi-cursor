import { describe, expect, it } from "vitest";

import type { CursorParameterizedModel } from "../src/client/cursor-wire.js";
import { augmentCursorModels } from "../src/models/parameterized.js";
import { buildRawModelLookup, modelConfig, processModels } from "../src/models/processing.js";
import type { CursorModel } from "../src/stream/model-discovery.js";

// Fixtures mirror the live GetUsableModels + AvailableModels responses from 2026-11.

function raw(id: string, name: string): CursorModel {
  return { id, name, reasoning: false, contextWindow: 200_000, maxTokens: 64_000 };
}

const DEEPSEEK = "deepseek-v41-flash-1017";
const DEEPSEEK_EFFORTS = ["none", "low", "medium", "high", "max"] as const;

const deepseekMetadata: CursorParameterizedModel = {
  name: DEEPSEEK,
  clientDisplayName: "DeepSeek V4.1 Flash 1017",
  supportsImages: false,
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  contextTokenLimit: 1_048_576,
  contextTokenLimitForMaxMode: 1_048_576,
  variants: DEEPSEEK_EFFORTS.flatMap((effort) =>
    [false, true].map((isMaxMode) => ({
      parameters: [{ id: "reasoning_effort", value: effort }],
      isMaxMode,
    })),
  ),
};

const deepseekRaw = DEEPSEEK_EFFORTS.map((effort) =>
  raw(`${DEEPSEEK}-${effort}`, `DeepSeek V4.1 Flash 1017 ${effort}`),
);

const GROK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

// Since grok-4.7 gained a context parameter, its effort comes as reasoning_effort.
const grok47Metadata: CursorParameterizedModel = {
  name: "grok-4.7",
  clientDisplayName: "Grok 4.7",
  supportsImages: false,
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  contextTokenLimit: 256_000,
  contextTokenLimitForMaxMode: 500_000,
  variants: GROK_EFFORTS.flatMap((effort) =>
    [false, true].map((fast) => ({
      parameters: [
        { id: "context", value: "256k" },
        { id: "reasoning_effort", value: effort },
        { id: "fast", value: String(fast) },
      ],
      isMaxMode: false,
    })),
  ),
};

const grok47Raw = GROK_EFFORTS.flatMap((effort) => [
  raw(`grok-4.7-${effort}`, `Grok 4.7 ${effort}`),
  raw(`grok-4.7-${effort}-fast`, `Grok 4.7 ${effort} Fast`),
]);

const kimiCodeMetadata: CursorParameterizedModel = {
  name: "kimi-k2.7-code",
  supportsImages: false,
  supportsMaxMode: true,
  supportsNonMaxMode: true,
  contextTokenLimit: 262_000,
  contextTokenLimitForMaxMode: 262_000,
  variants: [{ parameters: [], isMaxMode: false }],
};

function catalog(rawRows: CursorModel[], metadata: CursorParameterizedModel[]) {
  const models = processModels(augmentCursorModels(rawRows, metadata));
  const lookup = buildRawModelLookup(models);
  return {
    config: (id: string) => {
      const model = models.find((candidate) => candidate.id === id);
      if (!model) throw new Error(`no row ${id}; rows: ${models.map((m) => m.id).join(", ")}`);
      return modelConfig(model);
    },
    route: (id: string, effort: string) => lookup.get(id)?.[effort],
  };
}

describe("models whose effort parameter is reasoning_effort", () => {
  it("lets every DeepSeek row pick its reasoning effort", () => {
    const { config, route } = catalog(deepseekRaw, [deepseekMetadata]);

    for (const id of [DEEPSEEK, `${DEEPSEEK}-max-mode`]) {
      expect(config(id).reasoning).toBe(true);
      for (const effort of ["none", "low", "high", "max"]) {
        expect(route(id, effort)?.parameters).toEqual([{ id: "reasoning_effort", value: effort }]);
      }
    }
    expect(route(DEEPSEEK, "high")?.requestedMaxMode).toBeFalsy();
    expect(route(`${DEEPSEEK}-max-mode`, "high")?.requestedMaxMode).toBe(true);
  });

  it("no longer sends the most expensive effort when none is chosen", () => {
    const { route } = catalog(deepseekRaw, [deepseekMetadata]);

    expect(route(DEEPSEEK, "")?.parameters).toEqual([{ id: "reasoning_effort", value: "medium" }]);
    expect(route(`${DEEPSEEK}-max-mode`, "")?.parameters).toEqual([
      { id: "reasoning_effort", value: "medium" },
    ]);
  });

  it("maps pi's thinking off to DeepSeek's none", () => {
    const { route } = catalog(deepseekRaw, [deepseekMetadata]);

    expect(route(DEEPSEEK, "off")?.parameters).toEqual([{ id: "reasoning_effort", value: "none" }]);
  });

  it("gives the context-parameter Grok 4.7 rows an effort choice", () => {
    const { config, route } = catalog(grok47Raw, [grok47Metadata]);

    for (const id of ["grok-4.7-256k", "grok-4.7-256k-fast"]) {
      expect(config(id).reasoning).toBe(true);
      expect(route(id, "low")?.parameters).toContainEqual({ id: "reasoning_effort", value: "low" });
      expect(route(id, "xhigh")?.parameters).toContainEqual({
        id: "reasoning_effort",
        value: "xhigh",
      });
      expect(route(id, "")?.parameters).toContainEqual({
        id: "reasoning_effort",
        value: "medium",
      });
    }
  });

  it("keeps the Max Mode row ids those models already had", () => {
    const deepseek = catalog(deepseekRaw, [deepseekMetadata]);
    expect(() => deepseek.config(`${DEEPSEEK}-max-mode`)).not.toThrow();

    const withMax: CursorParameterizedModel = {
      ...grok47Metadata,
      variants: grok47Metadata.variants.map((variant) => ({ ...variant, isMaxMode: true })),
    };
    const grok = catalog(grok47Raw, [withMax]);
    expect(() => grok.config("grok-4.7-256k-max-mode")).not.toThrow();
    expect(() => grok.config("grok-4.7-256k-max-mode-fast")).not.toThrow();
  });
});

describe("raw rows next to AvailableModels metadata", () => {
  it("take the context window and image support Cursor reports", () => {
    const { config } = catalog(deepseekRaw, [deepseekMetadata]);

    expect(config(DEEPSEEK).contextWindow).toBe(1_048_576);
    expect(config(DEEPSEEK).input).toEqual(["text"]);
  });

  it("reach the bare Grok 4.7 rows, which keep their sibling routing", () => {
    const { config, route } = catalog(grok47Raw, [grok47Metadata]);

    for (const id of ["grok-4.7", "grok-4.7-fast"]) {
      expect(config(id).contextWindow).toBe(256_000);
      expect(config(id).input).toEqual(["text"]);
    }
    expect(route("grok-4.7", "high")).toMatchObject({ modelId: "grok-4.7-high" });
  });

  it("reach a model that has no effort", () => {
    const { config } = catalog([raw("kimi-k2.7-code", "Kimi K2.7 Code")], [kimiCodeMetadata]);

    expect(config("kimi-k2.7-code").contextWindow).toBe(262_000);
  });

  it("keep a context window the row names itself", () => {
    // Discovery reads 1M from the id; the overlay must not replace it with the family's 262K.
    const row = { ...raw("kimi-k2.7-code-1m", "Kimi K2.7 Code 1M"), contextWindow: 1_000_000 };
    const { config } = catalog([row], [kimiCodeMetadata]);

    expect(config("kimi-k2.7-code-1m").contextWindow).toBe(1_000_000);
  });

  it("are left alone without metadata", () => {
    const { config } = catalog(deepseekRaw, []);

    expect(config(DEEPSEEK).contextWindow).toBe(200_000);
  });
});
