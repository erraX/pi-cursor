/** Local operations are executed by Pi, never by the provider. */
import { create } from "@bufbuild/protobuf";

import { McpToolDefinitionSchema, type McpToolDefinition } from "../proto/agent_pb.js";
import {
  CURSOR_DYNAMIC_CALL_TOOL,
  CURSOR_PI_NAMESPACE,
  cursorMcpToolName,
  cursorMcpToolNames,
} from "./root-prompt.js";

export const MAX_LOCAL_TOOL_REJECTIONS = 8;
export const LOCAL_TOOL_LOOP_ERROR =
  `Cursor repeatedly requested disabled local tools (${MAX_LOCAL_TOOL_REJECTIONS} requests without a Pi tool result). ` +
  "Local operations must use the registered Pi MCP tools. Stopped to avoid an endless retry loop.";

const LOCAL_TOOL_HINTS: Record<string, string[]> = {
  readArgs: ["read", "Read", "bash"],
  lsArgs: ["ls", "LS", "bash"],
  grepArgs: ["grep", "Grep", "bash"],
  writeArgs: ["write", "Write", "edit", "Edit", "bash"],
  deleteArgs: ["bash"],
  shellArgs: ["bash"],
  shellStreamArgs: ["bash"],
  backgroundShellSpawnArgs: ["bash"],
  writeShellStdinArgs: ["bash"],
};

/** Identifies native file and shell requests that must be rejected in favor of Pi tools. */
export function isLocalToolExec(execCase: string): boolean {
  return Object.hasOwn(LOCAL_TOOL_HINTS, execCase);
}

const namesCache = new WeakMap<McpToolDefinition[], string[]>();
/** Caches nonempty tool names and aliases; the definitions array must remain immutable. */
export function availableToolNamesFor(tools: McpToolDefinition[]): string[] {
  const cached = namesCache.get(tools);
  if (cached) return cached;
  const names = [...new Set(tools.flatMap((tool) => [tool.toolName, tool.name]))].filter(Boolean);
  namesCache.set(tools, names);
  return names;
}

/** Registered names advertised under something other than their usual prefixed form. */
function renamedToolNames(available: readonly string[]): Array<[string, string]> {
  const names = cursorMcpToolNames(available);
  return available
    .map((name): [string, string] => [name, names.advertised(name)])
    .filter(([name, advertised]) => advertised !== cursorMcpToolName(name));
}

const wireCache = new WeakMap<McpToolDefinition[], McpToolDefinition[]>();
/**
 * The Pi catalog as sent in RunRequest and RequestContext, under the wire names of
 * `cursorMcpToolNames`. The registry passed to dispatch keeps Pi's own names.
 */
export function wireMcpToolDefinitions(tools: McpToolDefinition[]): McpToolDefinition[] {
  const cached = wireCache.get(tools);
  if (cached) return cached;
  const names = cursorMcpToolNames(availableToolNamesFor(tools));
  let changed = false;
  const wire = tools.map((tool) => {
    const name = tool.toolName || tool.name;
    const wireName = names.wire(name);
    if (wireName === name || (tool.providerIdentifier || "pi") !== "pi") return tool;
    changed = true;
    return create(McpToolDefinitionSchema, { ...tool, name: wireName, toolName: wireName });
  });
  const result = changed ? wire : tools;
  wireCache.set(tools, result);
  return result;
}

/** Lists registered tools with known matches first, custom tools visible, and bash last. */
export function localToolCandidates(execCase: string, tools: McpToolDefinition[]): string[] {
  const available = availableToolNamesFor(tools);
  const preferred = (LOCAL_TOOL_HINTS[execCase] ?? []).filter(
    (name) => name !== "bash" && available.includes(name),
  );
  // Custom tools may be more appropriate than a shell. Keep them visible even
  // when a known tool exists; names alone cannot establish their capabilities.
  return [
    ...new Set([
      ...preferred,
      ...available.filter((name) => name !== "bash"),
      ...available.filter((name) => name === "bash"),
    ]),
  ];
}

/*
 * Cursor's server never puts MCP tools in the model's native tool list. The model reaches
 * them only through its meta tools: `GetDynamicTools` (lookup) and `CallDynamicTool`
 * (invoke, `{ namespace, toolName, arguments }`). Cursor's own tool description tells the
 * model to look a tool up before every call, and nothing the model learned in one turn
 * survives into the next, because each request rebuilds the prompt from Pi's transcript.
 */

const MAX_CATALOG_DESCRIPTION_CHARS = 400;

function catalogDescription(description: string | undefined): string {
  const flat = (description ?? "").replace(/\s+/g, " ").trim();
  return flat.length > MAX_CATALOG_DESCRIPTION_CHARS
    ? `${flat.slice(0, MAX_CATALOG_DESCRIPTION_CHARS - 3)}...`
    : flat;
}

/**
 * Tells the model how Pi tools are invoked and publishes each tool's schema, so it can call
 * `CallDynamicTool` directly instead of trying native tools or calling `GetDynamicTools` on
 * every turn. Live probes on DeepSeek and Grok removed every lookup and native retry with
 * this catalog; names alone still left one lookup per turn.
 */
export function dynamicToolCatalogText(tools: McpToolDefinition[]): string {
  if (!tools.length) return "";
  const toolNames = cursorMcpToolNames(availableToolNamesFor(tools));
  const lines = tools.map((tool) => {
    const advertised = toolNames.advertised(tool.toolName || tool.name);
    const description = catalogDescription(tool.description);
    const schema = tool.inputSchemaJson || "{}";
    return `- ${advertised}: ${description ? `${description} ` : ""}Input schema: ${schema}`;
  });
  return (
    `How to call Pi tools: every Pi tool is an MCP tool in the dynamic namespace "${CURSOR_PI_NAMESPACE}". ` +
    "The mcp_pi_* names are not native tools and cannot be called directly. " +
    `Call each one only through ${CURSOR_DYNAMIC_CALL_TOOL} with namespace "${CURSOR_PI_NAMESPACE}", ` +
    "toolName set to the name exactly as listed below, and arguments set to an object that follows that tool's input schema. " +
    `The schemas below are the complete descriptors GetDynamicTools would return for namespace "${CURSOR_PI_NAMESPACE}", ` +
    `so they count as already inspected: do not call GetDynamicTools for namespace "${CURSOR_PI_NAMESPACE}". ` +
    "This applies to every turn of this conversation.\n" +
    `Pi tools in namespace "${CURSOR_PI_NAMESPACE}":\n${lines.join("\n")}`
  );
}

/** Explains a native rejection using registered tools and their schemas, or the current lack of tools. */
export function nativeToolRejectReason(execCase: string, tools: McpToolDefinition[]): string {
  const toolNames = cursorMcpToolNames(availableToolNamesFor(tools));
  const names = localToolCandidates(execCase, tools).map(toolNames.advertised);
  const guidance = names.length
    ? `Use the registered Pi MCP tools: ${names.join(", ")}. ` +
      `Call them through ${CURSOR_DYNAMIC_CALL_TOOL} with namespace "${CURSOR_PI_NAMESPACE}"; ` +
      "their schemas are listed in the rules. " +
      "Choose a tool that supports the operation and construct arguments according to its schema; " +
      "do not copy native Cursor arguments unchanged. If none supports it, report that limitation."
    : "No Pi MCP tools are exposed for this request, so this operation cannot be performed in this request.";
  return `Do not retry this native Cursor tool. It is unavailable. No operation was performed. ${guidance}`;
}

/** Builds prompt guidance for Pi-owned local operations, including tool-free requests. */
export function localToolPolicyText(tools: McpToolDefinition[]): string {
  const available = availableToolNamesFor(tools);
  const known = new Set(Object.values(LOCAL_TOOL_HINTS).flat());
  const names = available
    .filter((name) => known.has(name))
    .map(cursorMcpToolNames(available).advertised);
  const clashes = renamedToolNames(available).map(
    ([name, advertised]) => `call the custom tool "${name}" as ${advertised}`,
  );
  return (
    "Local file reads, searches, directory listings, writes, deletions and shell commands " +
    "must use Pi MCP tools. Native Cursor local tools are disabled; do not call or retry them. " +
    (available.length
      ? (names.length ? `Local Pi MCP tools: ${names.join(", ")}. ` : "") +
        (clashes.length ? `To avoid a name clash, ${clashes.join("; ")}. ` : "") +
        "Other exposed Pi tools may also support the operation. Follow each tool's input schema. " +
        "If no registered tool supports an operation, report that limitation.\n\n" +
        dynamicToolCatalogText(tools)
      : "No Pi MCP tools are exposed for this request. Local operations are unavailable in this request.")
  );
}
