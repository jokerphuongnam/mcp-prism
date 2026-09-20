/**
 * node-context-generator.ts — Entity-Aware LLM Pre-Processing Pipeline
 *
 * Two-pass enrichment with flavor-specific semantic templates:
 *   Pass 1: Leaf nodes (functions, macros, entry_points, targets)
 *   Pass 2: Parent nodes (classes, structs, enums, actors, protocols)
 *           — context incorporates children's resolved summaries
 *
 * Token templates per flavor:
 *   Function:  f:name|i:intent|p:params|d:deps|s:side_effects
 *   Class:     c:name|resp:responsibility|state:fields|d:deps
 *   Struct:    s:name|p:fields|i:data_purpose
 *   Protocol:  i:name|contract:behaviors|req:methods
 *   Enum:      e:name|cases:a,b,c|i:purpose
 *   Target:    lib:name|role:project_role|usage:features
 *
 * Usage:
 *   node dist/node-context-generator.js <graph-path> [--ollama-model codellama]
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { GraphNode } from "./fragment-store.js";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface NodeContextCache {
  version: string;
  entries: Record<string, CacheEntry>;
}

interface CacheEntry {
  fileHash: string;
  nodeContext: string;
  generatedAt: string;
}

interface GeneratorConfig {
  ollamaEndpoint: string;
  ollamaModel: string;
  maxConcurrent: number;
  timeoutMs: number;
  eligibleFlavors: Set<string>;
}

const DEFAULT_CONFIG: GeneratorConfig = {
  ollamaEndpoint: process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "codellama",
  maxConcurrent: 2,
  timeoutMs: 30_000,
  eligibleFlavors: new Set([
    "function", "class", "struct", "enum", "actor", "protocol",
    "macro", "entry_point", "target", "variable", "initializer",
  ]),
};

const OBJECT_FLAVORS = new Set(["class", "struct", "enum", "actor", "protocol"]);

// ═══════════════════════════════════════════════════════════════════════════════
// UNIVERSAL SEMANTIC PROTOCOL (USP) — Single prompt for all flavors
// ═══════════════════════════════════════════════════════════════════════════════

const USP_SYSTEM_PROMPT =
  "Distill this Swift code into a machine-to-machine logic flow.\n" +
  "Symbols: ->(flow) ?(cond) !(force) @(state change) tr(trigger/call) m:(modify) src:(source)\n" +
  "         g:(guard) ~>(propagation) snk:(sink) err:(error) sync:(thread) cost:L/H ⚠(risk)\n" +
  "Focus on: Logic constraints (guard/if, min/max), Animation triggers, Side-effects.\n" +
  "NO natural language. 1 line only.\n\n" +
  "Type: t:c t:s t:e t:p t:a t:tg  Exec: f i di g st ws ds\n\n" +
  "Examples:\n" +
  "  f|g:intensity!=nil!->m:blur.val->tr:layoutRefresh!$V|@UI|sync:main|cost:L\n" +
  "  e:ds|r:val->tr:setupBlur!|@UI\n" +
  "  e:ws|g:old!=new!->tr:validate->@pending~>delegate\n" +
  "  e:g|src:self.first,last->$S|cost:L\n" +
  "  t:c|i:ConnMgr|ini:socket!->@idle|di:kill!->@closed|sync:bg|err:retry\n" +
  "  t:a|i:DataSync|src:API->snk:cache|sync:actor|cost:H\n" +
  "  f|g:auth?valid!->tr:API.fetch->err:throw|sync:bg|cost:H\n\n" +
  "Output: 1 line. Symbolic only.\n";

// ═══════════════════════════════════════════════════════════════════════════════
// FILE HASH
// ═══════════════════════════════════════════════════════════════════════════════

function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Extract the full source body. Scans up to 300 lines to capture complete entities. */
function extractSourceCode(node: GraphNode, maxLines: number = 300): string | null {
  const filePath = node.location?.absPath;
  const startLine = node.location?.line;
  if (!filePath || !startLine || !fs.existsSync(filePath)) return null;

  try {
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");
    const start = Math.max(0, startLine - 1);
    let depth = 0;
    let foundOpen = false;
    let end = start;
    let complete = false;

    for (let i = start; i < Math.min(lines.length, start + maxLines); i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; foundOpen = true; }
        if (ch === "}") depth--;
      }
      end = i;
      if (foundOpen && depth <= 0) { complete = true; break; }
    }

    const source = lines.slice(start, end + 1).join("\n");
    if (!complete && foundOpen) {
      return source + `\n// ... truncated (${depth} open braces remaining)`;
    }
    return source;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OLLAMA CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

async function queryOllama(
  systemPrompt: string,
  userPrompt: string,
  config: GeneratorConfig
): Promise<string | null> {
  const body = JSON.stringify({
    model: config.ollamaModel,
    system: systemPrompt,
    prompt: userPrompt,
    stream: false,
    options: { temperature: 0.1, num_predict: 60 },
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const res = await fetch(`${config.ollamaEndpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const json = await res.json() as { response?: string };
    let text = json.response?.trim() ?? "";
    if (text.includes("\n")) text = text.split("\n")[0];
    if (text.length > 150) text = text.slice(0, 150);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRUCTURAL FALLBACK — Entity-specific dense summaries
// ═══════════════════════════════════════════════════════════════════════════════

function leafName(id: string): string {
  return id.split("::").pop() ?? id;
}

function extractTokens(contexts: string[], prefix: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const ctx of contexts) {
    for (const seg of ctx.split("|")) {
      if (seg.startsWith(prefix)) {
        const val = seg.slice(prefix.length);
        if (val && !seen.has(val)) { seen.add(val); results.push(val); }
      }
    }
  }
  return results;
}



function inferFunctionIntent(name: string): string | null {
  const n = name.toLowerCase();
  if (/^(get|fetch|load|read|query|find|search)/.test(n)) return "read";
  if (/^(set|update|save|write|store|put|patch)/.test(n)) return "write";
  if (/^(create|make|build|init|new|generate)/.test(n)) return "create";
  if (/^(delete|remove|drop|destroy|clear)/.test(n)) return "delete";
  if (/^(render|draw|display|show|present)/.test(n)) return "render";
  if (/^(validate|check|verify|assert|ensure)/.test(n)) return "validate";
  if (/^(configure|setup|register|bind)/.test(n)) return "setup";
  if (/^(handle|on[A-Z]|did|will|process)/.test(n)) return "handle";
  if (/^(parse|decode|encode|serialize|transform|convert)/.test(n)) return "transform";
  return null;
}

function inferStructPurpose(name: string): string | null {
  const n = name.toLowerCase();
  if (/config|setting|option/.test(n)) return "configuration";
  if (/request|response|payload/.test(n)) return "data_transfer";
  if (/model|entity|data|info/.test(n)) return "data_model";
  if (/state/.test(n)) return "state_container";
  if (/error|failure/.test(n)) return "error_type";
  return null;
}

function inferEnumPurpose(name: string): string | null {
  const n = name.toLowerCase();
  if (/route|screen|destination|tab/.test(n)) return "navigation";
  if (/state|status|phase/.test(n)) return "state_machine";
  if (/error|failure/.test(n)) return "error_cases";
  if (/action|event|command/.test(n)) return "action_dispatch";
  if (/type|kind|category|style/.test(n)) return "classification";
  return null;
}

/** Analyze init/deinit lifecycle for an object node. */
function analyzeLifecycle(
  node: GraphNode,
  sourceCode: string | null,
): { ini: string | null; di: string | null } {
  let ini: string | null = null;
  let di: string | null = null;

  // Init analysis
  const hasInits = node.inits && node.inits.length > 0;
  if (hasInits || sourceCode) {
    const traits: string[] = [];
    if (hasInits) {
      const deps = node.inits!.slice(0, 4).map(leafName);
      const callsExternal = deps.some((d) => !["self", "super"].includes(d.toLowerCase()));
      traits.push(callsExternal ? "triggers_logic" : "assign_only");
      traits.push(...deps);
    }
    if (sourceCode && /init\s*\(/.test(sourceCode)) {
      if (traits.length === 0) traits.push("assign_only");
      if (/addObserver|\.observe\(/.test(sourceCode)) traits.push("add_observers");
      if (/URLSession|connect|\.start\(\)/i.test(sourceCode)) traits.push("conn_remote");
      if (/Timer\.|schedule/i.test(sourceCode)) traits.push("start_timer");
      if (/super\.init/.test(sourceCode)) traits.push("calls_super");
    }
    const unique = [...new Set(traits)];
    if (unique.length > 0) ini = unique.slice(0, 4).join(",");
  }

  // Deinit analysis (reference types only)
  if (node.flavor === "class" || node.flavor === "actor") {
    const traits: string[] = [];
    if (node.deinits?.length) traits.push(...node.deinits.slice(0, 4).map(leafName));
    if (sourceCode && /deinit\s*\{/.test(sourceCode)) {
      if (/cancel\(\)|\.cancel\b/i.test(sourceCode)) traits.push("cancel_tasks");
      if (/removeObserver/i.test(sourceCode)) traits.push("remove_observers");
      if (/close\(\)|disconnect/i.test(sourceCode)) traits.push("close_conn");
      if (/invalidate\(\)/i.test(sourceCode)) traits.push("stop_timer");
      if (traits.length === 0) traits.push("cleanup");
    }
    const unique = [...new Set(traits)];
    if (unique.length > 0) di = unique.slice(0, 4).join(",");
  }

  return { ini, di };
}

/** Determine the executable sub-tag. Returns null for type-level nodes. */
function inferExecTag(node: GraphNode): string | null {
  const name = node.name.toLowerCase();
  if (node.flavor === "variable") {
    if (name === "willset" || name.endsWith(".willset")) return "ws";
    if (name === "didset" || name.endsWith(".didset")) return "ds";
    if (name === "getter" || name.endsWith(".get")) return "g";
    if (name === "setter" || name.endsWith(".set")) return "st";
    return "g"; // computed property default
  }
  if (node.flavor === "initializer") return "i";
  if (node.flavor === "function") {
    if (name === "deinit") return "di";
    return "f";
  }
  if (node.flavor === "entry_point") return "f";
  return null;
}

const APPLE_ROLES: Record<string, string> = {
  UIKit: "UI_framework", SwiftUI: "declarative_UI", Foundation: "core_runtime",
  CoreData: "persistence", Combine: "reactive_streams", MapKit: "maps",
  AVFoundation: "audio_video", Photos: "photo_library", StoreKit: "in_app_purchase",
  CloudKit: "cloud_sync", CoreLocation: "location", CoreGraphics: "2D_graphics",
  Metal: "GPU_graphics", Security: "crypto_keychain", CryptoKit: "cryptography",
};

function inferExtensionCapabilities(mergedSource: string | null): string | null {
  if (!mergedSource) return null;
  const extParts = mergedSource.split("// --- extension ---");
  if (extParts.length <= 1) return null;

  const extSource = extParts.slice(1).join("\n");
  const caps: string[] = [];

  if (/Codable|Decodable|Encodable/.test(extSource)) caps.push("coding");
  if (/Equatable|Hashable/.test(extSource)) caps.push("equality");
  if (/CustomStringConvertible/.test(extSource)) caps.push("debug_description");
  if (/tableView|collectionView|UITableView/.test(extSource)) caps.push("table_data_source");
  if (/@objc|#selector|@IBAction/.test(extSource)) caps.push("objc_actions");
  if (/\.snp\.|makeConstraints|NSLayoutConstraint/.test(extSource)) caps.push("layout");
  if (/style|theme|backgroundColor/.test(extSource)) caps.push("styling");
  if (/@Published|@State|Combine/.test(extSource)) caps.push("reactive");
  if (/PreviewProvider|#Preview/.test(extSource)) caps.push("preview");

  if (caps.length === 0) {
    const funcCount = (extSource.match(/func\s+\w+/g) ?? []).length;
    if (funcCount > 0) return `${funcCount}_methods`;
    return null;
  }
  return caps.slice(0, 4).join(",");
}

/** USP fallback — unified t:|i:|d:|s:|p:|r: tags for all flavors. */
function generateFallbackContext(
  node: GraphNode,
  sourceCode: string | null,
  childContexts: string[],
  callerNames: string[],
  extensionCount: number = 0,
): string {
  const parts: string[] = [];

  // Determine t: (type) or e: (executable) tag
  const exec = inferExecTag(node);
  if (exec) {
    parts.push(`e:${exec}`);
  } else {
    const TYPE_CODES: Record<string, string> = {
      class: "c", struct: "s", enum: "e", actor: "a", protocol: "p",
      macro: "m", target: "tg",
    };
    parts.push(`t:${TYPE_CODES[node.flavor] ?? node.flavor}`);
  }

  // i: — intent
  if (node.flavor === "target") {
    if (!node.origin) parts.push("i:internal_module");
    else if (node.origin === "Apple") parts.push(`i:${APPLE_ROLES[node.name] ?? "apple_sdk"}`);
    else parts.push("i:third_party");
  } else if (OBJECT_FLAVORS.has(node.flavor)) {
    if (childContexts.length > 0) {
      const intents = extractTokens(childContexts, "i:");
      if (intents.length > 0) parts.push(`i:${intents.slice(0, 3).join(",")}`);
    } else {
      const purpose = inferStructPurpose(node.name) ?? inferEnumPurpose(node.name);
      if (purpose) parts.push(`i:${purpose}`);
    }
  } else {
    // Executables — special-case accessors and lifecycle
    const lowName = node.name.toLowerCase();
    if (lowName === "willset" || lowName.endsWith(".willset")) parts.push("i:validate_before_set");
    else if (lowName === "didset" || lowName.endsWith(".didset")) parts.push("i:react_after_set");
    else if (lowName === "deinit") parts.push("i:cleanup");
    else if (node.flavor === "initializer" || lowName === "init" || lowName.startsWith("init(")) parts.push("i:initialize");
    else {
      const intent = inferFunctionIntent(node.name);
      if (intent) parts.push(`i:${intent}`);
    }
  }

  // p: — params/properties/cases
  if (node.parameters?.length) {
    parts.push(`p:${node.parameters.slice(0, 4).join(",")}`);
  } else if (node.flavor === "enum" && childContexts.length > 0) {
    const names = childContexts.slice(0, 5).map(c => { const m = c.match(/i:(\w+)/); return m?.[1]; }).filter(Boolean);
    if (names.length > 0) parts.push(`p:${names.join(",")}`);
  } else if (node.stores?.length) {
    parts.push(`p:${node.stores.slice(0, 5).map(leafName).join(",")}`);
  }

  // Behavioral deps: d: (structural), tr: (triggers), r: (reads for objects)
  const structural: string[] = [];
  if (node.extends) structural.push(leafName(node.extends));
  if (node.implements?.length) for (const id of node.implements.slice(0, 3)) structural.push(leafName(id));
  if (structural.length > 0) parts.push(`d:${structural.join(",")}`);

  const triggers: string[] = [];
  for (const id of (node.calls ?? []).slice(0, 4)) triggers.push(leafName(id));
  if (node.flavor === "target" && callerNames.length > 0) triggers.push(...callerNames.slice(0, 4));
  if (triggers.length > 0) parts.push(`tr:${triggers.join(",")}`);

  if (OBJECT_FLAVORS.has(node.flavor) && node.stores?.length) {
    parts.push(`r:${node.stores.slice(0, 3).map(leafName).join(",")}`);
  }

  // ret: — returns/requirements
  if (node.returns?.length) {
    parts.push(`ret:${node.returns.slice(0, 3).join(",")}`);
  } else if (node.flavor === "protocol" && childContexts.length > 0) {
    const methods = childContexts.slice(0, 4).map(c => { const m = c.match(/i:(\w+)/); return m?.[1]; }).filter(Boolean);
    if (methods.length > 0) parts.push(`ret:${methods.join(",")}`);
  }

  // Object-only: unified lifecycle + accessor + extension with UDLF flow
  if (OBJECT_FLAVORS.has(node.flavor)) {
    const lifecycle = analyzeLifecycle(node, sourceCode);
    if (lifecycle.ini) {
      const hasLogic = /triggers_logic|conn_remote|add_observers/.test(lifecycle.ini);
      const clean = lifecycle.ini.replace(/assign_only|triggers_logic,?/g, "").replace(/^,|,$/g, "");
      parts.push(`ini:${clean || "assign"}${hasLogic ? "!->@st:ready" : ""}`);
    }
    if (lifecycle.di) parts.push(`di:${lifecycle.di}!->@st:closed`);

    const accSummary = summarizeAccessors(childContexts);
    if (accSummary) parts.push(`acc:${accSummary}`);

    if (extensionCount > 0) {
      const extCaps = inferExtensionCapabilities(sourceCode);
      if (extCaps) parts.push(`ext:${extCaps}`);
    }
  }

  // Intelligence annotations
  if (sourceCode) {
    // err:
    if (/catch.*retry|retry.*catch/i.test(sourceCode)) parts.push("err:retry");
    else if (/\bthrow\b|\bthrows\b/.test(sourceCode)) parts.push("err:throw");
    else if (/try\?\s/.test(sourceCode)) parts.push("err:silent");

    // sync:
    if (node.flavor === "actor") parts.push("sync:actor");
    else if (/DispatchQueue\.main|@MainActor/.test(sourceCode)) parts.push("sync:main");
    else if (/DispatchQueue\.global|\.background/.test(sourceCode)) parts.push("sync:bg");
    else if (/\basync\b|\bawait\b|Task\s*\{/.test(sourceCode)) parts.push("sync:async");

    // cost:
    if (/for\s.*in\s.*for\s.*in/s.test(sourceCode)) parts.push("cost:H");
    else parts.push("cost:L");

    // p: pattern
    if (/\.shared\b|static\s+let\s+\w+\s*[:=]\s*\w+\(\)/.test(sourceCode)) parts.push("p:singleton");
    else if (/delegate\?\.|Delegate/.test(sourceCode)) parts.push("p:delegate");
    else if (/NotificationCenter|@Published|\.sink\b/.test(sourceCode)) parts.push("p:observer");

    // @ state effects
    const effects: string[] = [];
    if (/URLSession|URLRequest/i.test(sourceCode)) effects.push("net");
    if (/FileManager/i.test(sourceCode)) effects.push("disk");
    if (/UserDefaults|CoreData/i.test(sourceCode)) effects.push("state");
    if (/UIView|SwiftUI/i.test(sourceCode)) effects.push("ui");
    if (effects.length > 0) parts.push(`@${effects.join(",")}`);

    // ⚠ risk
    if (/DispatchQueue\.global|\.background/.test(sourceCode) && /UILabel|\.text\s*=|UIView/.test(sourceCode)) {
      parts.push("⚠:ui_off_main");
    }
  } else if (node.flavor === "actor") {
    parts.push("sync:actor");
    parts.push("cost:L");
  }

  // hub/leaf
  const callCount = (node.calls?.length ?? 0) + (node.inits?.length ?? 0);
  if (callCount >= 8) parts.push("hub");
  else if (callCount === 0 && !(node.stores?.length)) parts.push("leaf");

  return parts.join("|");
}

/** Summarize accessor behaviors from children contexts. */
function summarizeAccessors(childContexts: string[]): string | null {
  const accessors: string[] = [];
  for (const ctx of childContexts) {
    const execMatch = ctx.match(/^e:(ws|ds|g|st)/);
    if (!execMatch) continue;
    const tag = execMatch[1];
    const intentMatch = ctx.match(/\|i:([^|]+)/);
    if (intentMatch) {
      accessors.push(`${tag}>${intentMatch[1]}`);
    } else {
      accessors.push(tag);
    }
  }
  return accessors.length > 0 ? accessors.slice(0, 4).join(",") : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function loadCache(cachePath: string): NodeContextCache {
  if (!fs.existsSync(cachePath)) return { version: "2.0", entries: {} };
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  } catch {
    return { version: "2.0", entries: {} };
  }
}

function saveCache(cachePath: string, cache: NodeContextCache): void {
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN GENERATOR — Two-pass enrichment
// ═══════════════════════════════════════════════════════════════════════════════

export interface GenerateResult {
  total: number;
  generated: number;
  cached: number;
  failed: number;
  usedLLM: boolean;
}

export async function generateNodeContexts(
  graphPath: string,
  outputDir: string,
  configOverrides: Partial<GeneratorConfig> = {}
): Promise<GenerateResult> {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const cachePath = path.join(outputDir, "node-context-cache.json");
  const cache = loadCache(cachePath);

  const raw = fs.readFileSync(graphPath, "utf-8");
  const parsed = JSON.parse(raw);
  const nodes: GraphNode[] = Array.isArray(parsed) ? parsed : parsed.nodes ?? [];

  const result: GenerateResult = { total: 0, generated: 0, cached: 0, failed: 0, usedLLM: false };

  // Check Ollama
  let ollamaAvailable = false;
  try {
    const probe = await fetch(`${config.ollamaEndpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
    ollamaAvailable = probe.ok;
    if (ollamaAvailable) result.usedLLM = true;
    console.error(`[NodeContext] Ollama ${ollamaAvailable ? "available" : "not reachable"} (model: ${config.ollamaModel})`);
  } catch {
    console.error("[NodeContext] Ollama not reachable — using fallback");
  }

  // Build indexes
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    for (const pid of n.parents) {
      if (nodeMap.has(pid)) {
        const arr = childrenOf.get(pid) ?? [];
        arr.push(n.id);
        childrenOf.set(pid, arr);
      }
    }
  }
  const callersOf = new Map<string, string[]>();
  for (const n of nodes) {
    for (const callId of n.calls ?? []) {
      const arr = callersOf.get(callId) ?? [];
      arr.push(n.name);
      callersOf.set(callId, arr);
    }
  }

  // Partition
  const leaves: GraphNode[] = [];
  const parents: GraphNode[] = [];
  for (const n of nodes) {
    if (!config.eligibleFlavors.has(n.flavor)) continue;
    if (OBJECT_FLAVORS.has(n.flavor)) parents.push(n);
    else leaves.push(n);
  }
  result.total = leaves.length + parents.length;

  // Pass 1: Leaf nodes + targets
  for (const node of leaves) {
    await processNode(node, nodes, cache, config, ollamaAvailable, result, childrenOf, callersOf);
  }

  // Pass 2: Parent nodes (children already have contexts)
  for (const node of parents) {
    await processNode(node, nodes, cache, config, ollamaAvailable, result, childrenOf, callersOf);
  }

  // Pass 3: File-level and target-level hierarchical summaries
  const fileSummaries = buildFileSummaries(nodes);
  const targetSummaries = buildTargetSummaries(nodes);

  try {
    const metaPath = path.join(outputDir, "_meta_summaries.json");
    fs.writeFileSync(metaPath, JSON.stringify({ files: fileSummaries, targets: targetSummaries }));
  } catch { /* non-critical */ }

  // Write back
  const output = Array.isArray(parsed) ? nodes : { ...parsed, nodes };
  fs.writeFileSync(graphPath, JSON.stringify(output));
  saveCache(cachePath, cache);

  console.error(
    `[NodeContext] Done: ${result.generated} generated, ${result.cached} cached` +
    ` (LLM: ${result.usedLLM ? "yes" : "fallback"})`
  );

  return result;
}

function buildFileSummaries(nodes: GraphNode[]): Record<string, string> {
  const byFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (n.flavor === "target" || !n.location.absPath) continue;
    const arr = byFile.get(n.location.absPath) ?? [];
    arr.push(n);
    byFile.set(n.location.absPath, arr);
  }

  const summaries: Record<string, string> = {};
  for (const [filePath, fileNodes] of byFile) {
    const fileName = filePath.split("/").pop() ?? filePath;
    const types = new Set<string>();
    const intents: string[] = [];

    for (const n of fileNodes) {
      const ctx = n.node_context;
      if (!ctx) continue;
      for (const seg of ctx.split("|")) {
        if (seg.startsWith("t:") || seg.startsWith("e:")) types.add(seg);
        if (seg.startsWith("i:")) {
          const val = seg.slice(2);
          if (val && !intents.includes(val)) intents.push(val);
        }
      }
    }

    const parts: string[] = ["t:f", `n:${fileName}`];
    if (intents.length > 0) parts.push(`i:${intents.slice(0, 4).join(",")}`);
    if (types.size > 0) parts.push(`contains:${[...types].slice(0, 6).join(",")}`);
    parts.push(`count:${fileNodes.length}`);
    summaries[filePath] = parts.join("|");
  }
  return summaries;
}

function buildTargetSummaries(nodes: GraphNode[]): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const n of nodes) {
    if (n.flavor !== "target") continue;
    const prefix = `${n.id}::`;
    const contained = nodes.filter((c) => c.id.startsWith(prefix) && c.flavor !== "target");
    const objectCount = contained.filter((c) => OBJECT_FLAVORS.has(c.flavor)).length;
    const funcCount = contained.filter((c) => c.flavor === "function" || c.flavor === "variable").length;

    const intents: string[] = [];
    for (const c of contained) {
      if (!c.node_context) continue;
      for (const seg of c.node_context.split("|")) {
        if (seg.startsWith("i:")) {
          const val = seg.slice(2);
          if (val && !intents.includes(val)) intents.push(val);
        }
      }
    }

    const existing = n.node_context;
    const parts: string[] = existing
      ? [existing]
      : [`t:tg|i:${!n.origin ? "internal" : n.origin === "Apple" ? "apple_sdk" : "third_party"}`];
    if (objectCount > 0) parts.push(`types:${objectCount}`);
    if (funcCount > 0) parts.push(`funcs:${funcCount}`);
    if (!existing && intents.length > 0) parts.push(`scope:${intents.slice(0, 4).join(",")}`);
    summaries[n.id] = parts.join("|");
  }
  return summaries;
}

async function processNode(
  node: GraphNode,
  allNodes: GraphNode[],
  cache: NodeContextCache,
  config: GeneratorConfig,
  ollamaAvailable: boolean,
  result: GenerateResult,
  childrenOf: Map<string, string[]>,
  callersOf: Map<string, string[]>,
): Promise<void> {
  const isTarget = node.flavor === "target";
  const isParent = OBJECT_FLAVORS.has(node.flavor);

  // Children contexts for parent nodes
  const childContexts: string[] = [];
  if (isParent) {
    for (const childId of childrenOf.get(node.id) ?? []) {
      const child = allNodes.find((n) => n.id === childId);
      if (child?.node_context) childContexts.push(child.node_context);
    }
  }

  const callerNames = isTarget ? (callersOf.get(node.id) ?? []) : [];

  // For object nodes, merge primary definition + all extension blocks
  let sourceCode: string | null = null;
  let extensionCount = 0;
  if (!isTarget) {
    if (isParent && node.locations && node.locations.length > 0) {
      const blocks: string[] = [];
      const primary = extractSourceCode(node);
      if (primary) blocks.push(primary);
      for (const loc of node.locations) {
        const extNode = { ...node, location: loc } as GraphNode;
        const extSrc = extractSourceCode(extNode);
        if (extSrc) blocks.push(extSrc);
      }
      sourceCode = blocks.length > 0 ? blocks.join("\n\n// --- extension ---\n\n") : null;
      extensionCount = node.locations.length;
    } else {
      sourceCode = extractSourceCode(node);
    }
  }

  // Hash includes extension count + children count
  let hashInput: string;
  if (isTarget) {
    hashInput = `${node.id}:${node.origin ?? ""}:${callerNames.slice(0, 5).join(",")}`;
  } else {
    hashInput = sourceCode ?? `${node.id}:${node.flavor}:${node.name}`;
    if (extensionCount > 0) hashInput += `|ext:${extensionCount}`;
    if (childContexts.length > 0) hashInput += `|children:${childContexts.length}`;
    if (node.inits?.length) hashInput += `|inits:${node.inits.join(",")}`;
    if (node.deinits?.length) hashInput += `|deinits:${node.deinits.join(",")}`;
  }
  const fileHash = isTarget ? hashContent(hashInput) : (hashFile(node.location.absPath) ?? hashContent(hashInput));

  // Cache check
  const cached = cache.entries[node.id];
  if (cached && cached.fileHash === fileHash) {
    (node as any).node_context = cached.nodeContext;
    result.cached++;
    return;
  }

  // Try LLM with flavor-specific prompt (merged source includes extensions)
  let context: string | null = null;
  if (ollamaAvailable) {
    if (isTarget) {
      const meta = [`Library: ${node.name}`];
      if (node.origin) meta.push(`Origin: ${node.origin}`);
      if (callerNames.length > 0) meta.push(`Used by: ${callerNames.slice(0, 8).join(", ")}`);
      context = await queryOllama(USP_SYSTEM_PROMPT, meta.join("\n"), config);
    } else if (sourceCode) {
      let prompt = sourceCode;
      if (isParent && childContexts.length > 0) {
        prompt += `\n\n// Members context:\n// ${childContexts.slice(0, 6).join("\n// ")}`;
      }
      context = await queryOllama(USP_SYSTEM_PROMPT, prompt, config);
    }
  }

  // Fallback — pass extensionCount for ext: token
  if (!context) {
    context = generateFallbackContext(node, sourceCode, childContexts, callerNames, extensionCount);
  }

  (node as any).node_context = context;
  cache.entries[node.id] = { fileHash, nodeContext: context, generatedAt: new Date().toISOString() };
  result.generated++;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEALTH COMPRESSION
// ═══════════════════════════════════════════════════════════════════════════════

const STEALTH_COMPRESSION_MAP: [RegExp, string][] = [
  [/\bfunc\b/g, "f"], [/\bfunction\b/g, "f"], [/\bvariable\b/g, "v"],
  [/\breturn\b/g, "r"], [/\bstruct\b/g, "S"], [/\bclass\b/g, "C"],
  [/\benum\b/g, "E"], [/\bprotocol\b/g, "P"], [/\bextension\b/g, "X"],
  [/\bproperty\b/g, "p"], [/\boptional\b/g, "?"], [/\basync\b/g, "⚡"],
  [/\bawait\b/g, "⏳"], [/\bthrows\b/g, "⚠"], [/\bpublic\b/g, "+"],
  [/\bprivate\b/g, "-"], [/\binternal\b/g, "~"], [/\bstatic\b/g, "§"],
  [/\bmutating\b/g, "μ"], [/\boverride\b/g, "↑"], [/\binit\b/g, "⊕"],
  [/\bdeinit\b/g, "⊖"], [/\bString\b/g, "Str"], [/\bInt\b/g, "I"],
  [/\bBool\b/g, "B"], [/\bDouble\b/g, "D"], [/\bArray\b/g, "[]"],
  [/\bDictionary\b/g, "{}"], [/\bVoid\b/g, "∅"], [/\bnil\b/g, "∅"],
  [/\bself\b/g, "λ"], [/\bguard\b/g, "G"], [/\bimport\b/g, "⬇"],
];

export function applyStealthCompression(context: string): string {
  let result = context;
  for (const [pattern, replacement] of STEALTH_COMPRESSION_MAP) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(/\s{2,}/g, " ").trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

if (process.argv[1]?.endsWith("node-context-generator.js") || process.argv[1]?.endsWith("node-context-generator.ts")) {
  const graphPath = process.argv[2];
  if (!graphPath) {
    console.error("Usage: node node-context-generator.js <graph-path> [--ollama-model <model>]");
    process.exit(1);
  }

  const modelIdx = process.argv.indexOf("--ollama-model");
  const model = modelIdx >= 0 ? process.argv[modelIdx + 1] : undefined;

  generateNodeContexts(graphPath, path.dirname(graphPath), model ? { ollamaModel: model } : {})
    .then((r) => console.log(JSON.stringify(r)))
    .catch((err) => { console.error("Generation failed:", err); process.exit(1); });
}
