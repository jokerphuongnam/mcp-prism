#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { FragmentLoader, type GraphNode } from "./fragment-store.js";
import { applyStealthCompression } from "./node-context-generator.js";
import {
  GraphDatabase,
  importGraphFromJson,
  sqlitePathBesideGraph,
} from "./graph-db.js";

interface GraphData {
  nodes: GraphNode[];
  targets?: { name: string; type: string; isExternal: boolean }[];
}

interface ProjectPaths {
  graphPath: string;
  contextsDir: string;
  projectRoot: string;
  /** SQLite SoT when present (beside prism-context.json). */
  sqlitePath?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT DISCOVERY — Hidden Data Resolution
//
// 1. Walk upward from CWD to find the Project Anchor (.git, Package.swift, …)
// 2. Resolve SoT at <anchor>/.codeprism/ (preferred) or .swiftprism/ (legacy)
// 3. Fall back to visible *-config.json / prism-context.json at anchor root
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT_ANCHORS = [".git", "Package.swift", "package.json", "build.gradle.kts", "Application.marlin"];
/** Preferred language-agnostic SoT dir; .swiftprism kept for older Swift runs. */
const HIDDEN_DIRS = [".codeprism", ".swiftprism"];
const HIDDEN_CONFIGS = ["codeprism-config.json", "swiftprism-config.json"];
const STEALTH_MODE = process.env.SWIFTPRISM_MODE === "stealth" || process.env.CODEPRISM_MODE === "stealth";
const STEALTH_COMPRESSION = process.env.SWIFTPRISM_COMPRESS === "1" || process.env.CODEPRISM_COMPRESS === "1";

// ── Project Anchor Discovery ──
// Walk upward from startDir to find the nearest directory containing
// .git, Package.swift, or *.xcodeproj. Returns the anchor directory.
function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    for (const anchor of PROJECT_ANCHORS) {
      if (fs.existsSync(path.join(dir, anchor))) return dir;
    }
    try {
      if (fs.readdirSync(dir).some((e: string) => e.endsWith(".xcodeproj"))) return dir;
    } catch { /* unreadable — skip */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── Config Loader ──
// Reads swiftprism-config.json, resolves relative paths against baseDir,
// and verifies the graph file exists on disk.
function tryLoadConfig(configPath: string, baseDir: string, projectRoot: string): ProjectPaths | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const resolvedGraph = cfg.graphPath
      ? (path.isAbsolute(cfg.graphPath) ? cfg.graphPath : path.resolve(baseDir, cfg.graphPath))
      : null;
    if (!resolvedGraph || !fs.existsSync(resolvedGraph)) return null;
    const sqliteCandidate = cfg.sqlitePath
      ? (path.isAbsolute(cfg.sqlitePath) ? cfg.sqlitePath : path.resolve(baseDir, cfg.sqlitePath))
      : sqlitePathBesideGraph(resolvedGraph);
    return {
      graphPath: resolvedGraph,
      contextsDir: cfg.contextsDir
        ? (path.isAbsolute(cfg.contextsDir) ? cfg.contextsDir : path.resolve(baseDir, cfg.contextsDir))
        : path.join(path.dirname(resolvedGraph), "contexts"),
      projectRoot,
      sqlitePath: fs.existsSync(sqliteCandidate) ? sqliteCandidate : undefined,
    };
  } catch {
    return null;
  }
}

// ── Path Resolution ──
// Prefer .codeprism (language-agnostic), then .swiftprism (legacy Swift).
function tryHiddenSoT(anchor: string): ProjectPaths | null {
  for (const hiddenName of HIDDEN_DIRS) {
    const hiddenDir = path.join(anchor, hiddenName);
    for (const cfgName of HIDDEN_CONFIGS) {
      const loaded = tryLoadConfig(path.join(hiddenDir, cfgName), hiddenDir, anchor);
      if (loaded) return loaded;
    }
    // Direct graph files without config
    const jsonPath = path.join(hiddenDir, "prism-context.json");
    if (fs.existsSync(jsonPath)) {
      const sqliteCandidate = sqlitePathBesideGraph(jsonPath);
      return {
        graphPath: jsonPath,
        contextsDir: path.join(hiddenDir, "contexts"),
        projectRoot: anchor,
        sqlitePath: fs.existsSync(sqliteCandidate) ? sqliteCandidate : undefined,
      };
    }
  }
  return null;
}

function resolveProjectPaths(): ProjectPaths | null {
  // PRISM_CWD overrides process.cwd() for location-agnostic deployment
  const cwd = process.env.PRISM_CWD || process.cwd();
  const anchor = findProjectRoot(cwd);

  if (anchor) {
    const hidden = tryHiddenSoT(anchor);
    if (hidden) return hidden;

    if (!STEALTH_MODE) {
      for (const cfgName of HIDDEN_CONFIGS) {
        const visible = tryLoadConfig(path.join(anchor, cfgName), anchor, anchor);
        if (visible) return visible;
      }
      const legacyPath = path.join(anchor, "prism-context.json");
      if (fs.existsSync(legacyPath)) {
        const sqliteCandidate = sqlitePathBesideGraph(legacyPath);
        return {
          graphPath: legacyPath,
          contextsDir: path.join(anchor, "out", "contexts"),
          projectRoot: anchor,
          sqlitePath: fs.existsSync(sqliteCandidate) ? sqliteCandidate : undefined,
        };
      }
    }
  }

  let dir = cwd;
  while (true) {
    const hidden = tryHiddenSoT(dir);
    if (hidden) return hidden;
    if (!STEALTH_MODE) {
      for (const cfgName of HIDDEN_CONFIGS) {
        const visible = tryLoadConfig(path.join(dir, cfgName), dir, dir);
        if (visible) return visible;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

const NOT_CONFIGURED_MSG =
  "Graph data not found. Please run ./run.sh in your project root to initialize the " +
  (STEALTH_MODE ? "stealth context." : "graph data.");

function notConfiguredResponse() {
  return { content: [{ type: "text" as const, text: NOT_CONFIGURED_MSG }] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY GRAPH STORE — Load once, O(1) lookup, file-watch reload
//
// The graph is loaded into memory on startup and reloaded when the file changes.
// No fragments/ directory needed — all fragmentation is done on-demand per request.
// ═══════════════════════════════════════════════════════════════════════════════

let _graphNodes: GraphNode[] = [];
let _nodeById: Map<string, GraphNode> = new Map();
let _callerIndex: Map<string, string[]> = new Map(); // targetId → [callerIds]
let _graphLoaded = false;
let _graphDb: GraphDatabase | null = null;

function ensureSqliteBesideJson(paths: ProjectPaths): string | undefined {
  const dbPath = paths.sqlitePath ?? sqlitePathBesideGraph(paths.graphPath);
  if (fs.existsSync(dbPath)) return dbPath;
  // Auto-import once so MCP works after older ./run.sh that only wrote JSON.
  try {
    const result = importGraphFromJson(paths.graphPath, dbPath);
    console.error(
      `[SwiftPrism MCP] Imported JSON → SQLite: ${result.nodeCount} nodes, ${result.edgeCount} edges → ${result.dbPath}`
    );
    return result.dbPath;
  } catch (err) {
    console.error("[SwiftPrism MCP] SQLite import skipped:", err);
    return undefined;
  }
}

function loadGraphIntoMemory(): boolean {
  const paths = resolveProjectPaths();
  if (!paths) return false;
  try {
    // Prefer SQLite SoT when available (or freshly imported).
    const dbPath = ensureSqliteBesideJson(paths);
    if (dbPath) {
      _graphDb?.close();
      _graphDb = new GraphDatabase(dbPath, true);
      const mem = _graphDb.loadAllIntoMemory();
      _graphNodes = mem.nodes;
      _nodeById = mem.nodeById;
      _callerIndex = mem.callerIndex;
      _graphLoaded = true;
      console.error(
        `[SwiftPrism MCP] Graph loaded from SQLite: ${mem.nodes.length} nodes, ${mem.callerIndex.size} reverse links (${path.basename(dbPath)})`
      );
      return true;
    }

    const raw = fs.readFileSync(paths.graphPath, "utf-8");
    const parsed = JSON.parse(raw);
    const nodes: GraphNode[] = Array.isArray(parsed) ? parsed : parsed.nodes ?? [];

    _graphNodes = nodes;
    _nodeById = new Map(nodes.map((n) => [n.id, n]));

    _callerIndex = new Map();
    for (const n of nodes) {
      for (const callId of [...(n.calls ?? []), ...(n.inits ?? []), ...(n.deinits ?? [])]) {
        const arr = _callerIndex.get(callId) ?? [];
        arr.push(n.id);
        _callerIndex.set(callId, arr);
      }
    }

    _graphLoaded = true;
    console.error(`[SwiftPrism MCP] Graph loaded from JSON: ${nodes.length} nodes, ${_callerIndex.size} reverse links`);
    return true;
  } catch (err) {
    console.error("[SwiftPrism MCP] Failed to load graph:", err);
    return false;
  }
}

/** Legacy fragment loader — still used by get_lifecycle_map for loadObject */
function getFragmentLoader(): FragmentLoader | null {
  const paths = resolveProjectPaths();
  if (!paths) return null;
  const loader = new FragmentLoader(path.dirname(paths.graphPath));
  return loader.available ? loader : null;
}

function loadGraph(): GraphData | null {
  if (_graphLoaded) return { nodes: _graphNodes };
  if (loadGraphIntoMemory()) return { nodes: _graphNodes };
  return null;
}

function findNode(id: string): GraphNode | undefined {
  if (!_graphLoaded) loadGraphIntoMemory();
  return _nodeById.get(id);
}

function findCallers(targetId: string): GraphNode[] {
  if (!_graphLoaded) loadGraphIntoMemory();
  const callerIds = _callerIndex.get(targetId) ?? [];
  return callerIds.map((id) => _nodeById.get(id)).filter(Boolean) as GraphNode[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKEN-OPTIMIZED OUTPUT — Prefer node_context over full node data
//
// When node_context is present, return a compact representation.
// If stealth compression is active, further shorten Swift terms.
// Full source is only sent when explicitly requested (full_source=true).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Atomic node response — One Node = One JSON.
 * Contains only this node's own data. Never inlines other nodes' contexts.
 * The agent calls get_node_info on each ID in calls/inits/parents to fetch their data.
 */
function toTokenOptimized(node: GraphNode, fullSource: boolean = false): Record<string, any> {
  if (fullSource || !node.node_context) {
    return node;
  }

  const context = STEALTH_COMPRESSION
    ? applyStealthCompression(node.node_context)
    : node.node_context;

  return {
    id: node.id,
    name: node.name,
    flavor: node.flavor,
    node_context: context,
    location: node.location,
    parents: node.parents,
    ...(node.calls?.length ? { calls: node.calls } : {}),
    ...(node.inits?.length ? { inits: node.inits } : {}),
    ...(node.deinits?.length ? { deinits: node.deinits } : {}),
    ...(node.stores?.length ? { stores: node.stores } : {}),
  };
}

/**
 * Resolve tagged index references in a node_context string.
 * Replaces c[0], i[1], di[0], imp[2] etc. with the actual entity name from the node's arrays.
 * The original symbolic operators (!, ?, ~>, ->) are preserved.
 */
function resolveIndexTags(context: string, node: GraphNode): string {
  return context.replace(/(!|~>|\?|->)?(c|i|di|imp)\[(\d+)\]/g, (_match, prefix, tag, idxStr) => {
    const idx = parseInt(idxStr, 10);
    let arr: string[] | undefined;
    if (tag === "c") arr = node.calls;
    else if (tag === "i") arr = node.inits;
    else if (tag === "di") arr = node.deinits;
    else if (tag === "imp") arr = node.implements;

    const resolved = arr?.[idx];
    if (!resolved) return _match; // index out of bounds — keep original
    const name = resolved.split("::").pop() ?? resolved;
    return `${prefix ?? ""}${name}`;
  });
}

function toTokenOptimizedFragment(id: string, nodeById: Map<string, GraphNode>, fullSource: boolean = false): Record<string, any> {
  const node = nodeById.get(id);
  if (!node) return { id, name: id, flavor: "unknown" };
  return toTokenOptimized(node, fullSource);
}

function traceGraph(
  nodeId: string,
  depth: number,
  direction: "outgoing" | "incoming" | "both"
): { nodes: string[]; edges: { from: string; to: string }[] } {
  const visited = new Set<string>();
  const edges: { from: string; to: string }[] = [];

  function walk(id: string, d: number) {
    if (d <= 0 || visited.has(id)) return;
    visited.add(id);
    const node = findNode(id);
    if (!node) return;

    if (direction === "outgoing" || direction === "both") {
      for (const call of node.calls ?? []) {
        edges.push({ from: id, to: call });
        walk(call, d - 1);
      }
      for (const init of node.inits ?? []) {
        edges.push({ from: id, to: init });
        walk(init, d - 1);
      }
    }

    if (direction === "incoming" || direction === "both") {
      for (const caller of findCallers(id)) {
        edges.push({ from: caller.id, to: id });
        walk(caller.id, d - 1);
      }
    }
  }

  walk(nodeId, depth);
  return { nodes: Array.from(visited), edges };
}

/** Load file-level and target-level meta summaries from _meta_summaries.json */
function loadMetaSummaries(): { files: Record<string, string>; targets: Record<string, string> } | null {
  const paths = resolveProjectPaths();
  if (!paths) return null;
  const metaPath = path.join(path.dirname(paths.graphPath), "_meta_summaries.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

const server = new McpServer({
  name: "mcp-prism",
  version: "1.0.0",
});

server.resource("graph", "graph://entire", async (uri) => {
  // Prefer fragment index stats (no full load)
  const loader = getFragmentLoader();
  if (loader) {
    const stats = loader.getStats();
    if (stats) {
      const meta = loadMetaSummaries();
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            nodeCount: stats.nodeCount, fragmentCount: stats.fragmentCount,
            sharedCount: stats.sharedCount, generatedAt: stats.generatedAt,
            mode: "fragmented",
            ...(meta ? { fileSummaryCount: Object.keys(meta.files).length, targetSummaryCount: Object.keys(meta.targets).length } : {}),
          }),
        }],
      };
    }
  }
  const data = loadGraph();
  if (!data) return { contents: [{ uri: uri.href, mimeType: "text/plain", text: NOT_CONFIGURED_MSG }] };
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({
          nodeCount: data.nodes.length,
          targets: data.targets ?? [],
          mode: "monolithic",
          flavors: Object.fromEntries(
            [...new Set(data.nodes.map((n) => n.flavor))].map((f) => [
              f,
              data.nodes.filter((n) => n.flavor === f).length,
            ])
          ),
        }),
      },
    ],
  };
});

server.resource(
  "target",
  "target://{name}",
  async (uri) => {
    const name = new URL(uri.href).hostname || uri.href.replace("target://", "");
    const data = loadGraph();
    if (!data) return { contents: [{ uri: uri.href, mimeType: "text/plain", text: NOT_CONFIGURED_MSG }] };
    const nodes = data.nodes.filter(
      (n) => n.id.startsWith(`${name}::`) || n.id === name
    );
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            target: name,
            nodeCount: nodes.length,
            nodes: nodes.map((n) => ({
              id: n.id,
              name: n.name,
              flavor: n.flavor,
            })),
          }),
        },
      ],
    };
  }
);

server.resource(
  "file",
  "file://{filePath}",
  async (uri) => {
    const filePath = uri.href.replace("file://", "");
    const data = loadGraph();
    if (!data) return { contents: [{ uri: uri.href, mimeType: "text/plain", text: NOT_CONFIGURED_MSG }] };
    const nodes = data.nodes.filter(
      (n) =>
        n.location.absPath.endsWith(filePath) ||
        n.parents.some((p) => p === filePath || p === `file:${filePath}`)
    );
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            file: filePath,
            nodeCount: nodes.length,
            ...((() => {
              const meta = loadMetaSummaries();
              if (!meta) return {};
              const match = Object.entries(meta.files).find(([p]) => p.endsWith(filePath));
              return match ? { semantic_context: match[1] } : {};
            })()),
            nodes: nodes.map((n) => ({
              id: n.id,
              name: n.name,
              flavor: n.flavor,
              line: n.location.line,
            })),
          }),
        },
      ],
    };
  }
);

server.tool(
  "get_node_info",
  {
    node_id: z.string().optional().describe("Single node ID (e.g. App::BlurEffectView::intensity[didSet])"),
    node_ids: z.array(z.string()).optional().describe("Batch: multiple node IDs to fetch at once"),
    full_source: z.boolean().default(false).describe("If true, return full node data instead of pre-digested context"),
  },
  async ({ node_id, node_ids, full_source }) => {
    // Batch mode: fetch multiple nodes in one call
    const ids = node_ids ?? (node_id ? [node_id] : []);
    if (ids.length === 0) {
      return { content: [{ type: "text" as const, text: "Provide node_id or node_ids." }] };
    }

    // Single node — original compact response
    if (ids.length === 1) {
      const node = findNode(ids[0]);
      if (!node) {
        return { content: [{ type: "text" as const, text: `Node not found: ${ids[0]}` }] };
      }
      const result = toTokenOptimized(node, full_source);
      if (result.node_context && /[cdi]\[\d+\]|imp\[\d+\]/.test(result.node_context)) {
        result.resolved_context = resolveIndexTags(result.node_context, node);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }

    // Batch — array of atomic node objects
    const results = ids.map((id) => {
      const node = findNode(id);
      if (!node) return { id, error: "not_found" };
      const result = toTokenOptimized(node, full_source);
      if (result.node_context && /[cdi]\[\d+\]|imp\[\d+\]/.test(result.node_context)) {
        result.resolved_context = resolveIndexTags(result.node_context, node);
      }
      return result;
    });

    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  "trace_dependency",
  {
    node_id: z.string().describe("Node ID to trace from"),
    depth: z.number().default(3).describe("Max traversal depth (default 3)"),
    direction: z.enum(["outgoing", "incoming", "both"]).default("both").describe("Trace direction"),
  },
  async ({ node_id, depth, direction }) => {
    const result = traceGraph(node_id, depth, direction);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              root: node_id,
              depth,
              direction,
              reachableNodes: result.nodes.length,
              nodes: result.nodes,
              edges: result.edges,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "find_impact_range",
  { node_id: z.string().describe("Node ID to analyze impact for") },
  async ({ node_id }) => {
    const callers = findCallers(node_id);
    const node = findNode(node_id);

    // Atomic: return only IDs and relationship type. Agent calls get_node_info per ID.
    const directCallers = callers.map((c) => ({
      id: c.id,
      relation: "calls",
    }));

    const transitiveTrace = traceGraph(node_id, 5, "incoming");

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              target: node_id,
              targetFlavor: node?.flavor ?? "unknown",
              directCallers,
              transitiveImpact: transitiveTrace.nodes.length,
              affectedNodeIds: transitiveTrace.nodes,
              affectedFiles: [
                ...new Set(
                  transitiveTrace.nodes
                    .map((id) => findNode(id)?.location.absPath)
                    .filter(Boolean)
                ),
              ],
              _hint: "Call get_node_info on each ID to fetch its node_context for reasoning.",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// get_lifecycle_map — Fetch init/deinit lifecycle for a class/actor
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// get_lifecycle_map — Parse ini:/di: from node_context into a chronological timeline
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_lifecycle_map",
  {
    node_id: z.string().describe("Object node ID (class/actor) to inspect lifecycle for"),
  },
  async ({ node_id }) => {
    const node = findNode(node_id);
    if (!node) {
      return { content: [{ type: "text" as const, text: `Node not found: ${node_id}` }] };
    }

    const OBJECT_FLAVORS = new Set(["class", "struct", "enum", "actor", "protocol"]);
    if (!OBJECT_FLAVORS.has(node.flavor)) {
      return { content: [{ type: "text" as const, text: `Not an object node (flavor: ${node.flavor}).` }] };
    }

    // Parse ini: and di: phases from node_context
    const ctx = node.node_context ?? "";
    const iniMatch = ctx.match(/ini:([^|]+)/);
    const diMatch = ctx.match(/di:([^|]+)/);

    // Build chronological timeline by resolving index tags
    const initTimeline: { step: number; tag: string; resolved: string; behavior: string }[] = [];
    if (iniMatch) {
      const iniRaw = iniMatch[1];
      // Split by -> (sequence) and , (parallel)
      const steps = iniRaw.split(/->/).map((s) => s.trim());
      for (let s = 0; s < steps.length; s++) {
        for (const part of steps[s].split(",")) {
          const tagMatch = part.match(/([!?~>]*)i\[(\d+)\]/);
          if (tagMatch) {
            const idx = parseInt(tagMatch[2], 10);
            const id = node.inits?.[idx];
            const name = id ? (id.split("::").pop() ?? id) : `inits[${idx}]`;
            const behavior = tagMatch[1] === "!" ? "mandatory" : tagMatch[1] === "?" ? "conditional" : "sequential";
            initTimeline.push({ step: s, tag: part.trim(), resolved: name, behavior });
          } else {
            // Behavior descriptor (e.g., bind_obs, conn)
            initTimeline.push({ step: s, tag: part.trim(), resolved: part.trim(), behavior: "side_effect" });
          }
        }
      }
    }

    const deinitTimeline: { tag: string; resolved: string; behavior: string }[] = [];
    if (diMatch) {
      for (const part of diMatch[1].split(",")) {
        const tagMatch = part.match(/([!?~>]*)di\[(\d+)\]/);
        if (tagMatch) {
          const idx = parseInt(tagMatch[2], 10);
          const id = node.deinits?.[idx];
          const name = id ? (id.split("::").pop() ?? id) : `deinits[${idx}]`;
          deinitTimeline.push({ tag: part.trim(), resolved: name, behavior: tagMatch[1] === "!" ? "mandatory" : "sequential" });
        } else {
          deinitTimeline.push({ tag: part.trim(), resolved: part.trim(), behavior: "cleanup" });
        }
      }
    }

    // Accessors
    const loader = getFragmentLoader();
    const accessorIds: string[] = [];
    if (loader) {
      for (const child of loader.loadObject(node_id)) {
        if (child.flavor === "variable" && child.id !== node_id) accessorIds.push(child.id);
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          node_id,
          node_context: ctx || null,
          resolved_context: ctx ? resolveIndexTags(ctx, node) : null,
          lifecycle: {
            init: { raw: iniMatch?.[1] ?? null, timeline: initTimeline },
            deinit: { raw: diMatch?.[1] ?? null, timeline: deinitTimeline },
          },
          arrays: {
            inits: node.inits ?? [],
            deinits: node.deinits ?? [],
            implements: node.implements ?? [],
          },
          accessorIds,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// resolve_node_logic — Resolve index tags into human/AI-readable logic flow
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "resolve_node_logic",
  {
    node_id: z.string().describe("Node ID to resolve logic for"),
  },
  async ({ node_id }) => {
    const node = findNode(node_id);
    if (!node) {
      return { content: [{ type: "text" as const, text: `Node not found: ${node_id}` }] };
    }

    if (!node.node_context) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ node_id, resolved: null, reason: "No node_context generated" }) }] };
    }

    const resolved = resolveIndexTags(node.node_context, node);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          node_id,
          raw_context: node.node_context,
          resolved_context: resolved,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// trace_impact_chain — Scan callers' node_context for index refs to the target
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "trace_impact_chain",
  {
    node_id: z.string().describe("Node ID to trace impact for — who references it and HOW"),
  },
  async ({ node_id }) => {
    const node = findNode(node_id);
    if (!node) {
      return { content: [{ type: "text" as const, text: `Node not found: ${node_id}` }] };
    }

    const callers = findCallers(node_id);
    const targetName = node_id.split("::").pop() ?? node_id;

    // Scan each caller's node_context for index references that resolve to our target
    const impacts: { caller_id: string; behavior: string; raw_ref: string; context_snippet: string }[] = [];

    for (const caller of callers) {
      if (!caller.node_context) {
        impacts.push({ caller_id: caller.id, behavior: "unknown", raw_ref: "—", context_snippet: "no context" });
        continue;
      }

      // Find which array and index points to our target
      let foundRef: string | null = null;
      let behavior = "calls";

      // Check calls[] array
      const callIdx = caller.calls?.indexOf(node_id) ?? -1;
      if (callIdx >= 0) {
        // Look for c[callIdx] in the caller's context
        const refPattern = new RegExp(`([!?]|~>)?c\\[${callIdx}\\]`);
        const match = caller.node_context.match(refPattern);
        if (match) {
          foundRef = match[0];
          const prefix = match[1] ?? "";
          behavior = prefix === "!" ? "mandatory" : prefix === "?" ? "conditional" : prefix === "~>" ? "async_side_effect" : "sequential";
        } else {
          foundRef = `c[${callIdx}]`;
          behavior = "calls";
        }
      }

      // Check inits[] array
      if (!foundRef) {
        const initIdx = caller.inits?.indexOf(node_id) ?? -1;
        if (initIdx >= 0) {
          const refPattern = new RegExp(`([!?])?i\\[${initIdx}\\]`);
          const match = caller.node_context.match(refPattern);
          foundRef = match ? match[0] : `i[${initIdx}]`;
          behavior = match?.[1] === "!" ? "mandatory_init" : "init";
        }
      }

      // Check deinits[] array
      if (!foundRef) {
        const diIdx = caller.deinits?.indexOf(node_id) ?? -1;
        if (diIdx >= 0) {
          foundRef = `di[${diIdx}]`;
          behavior = "cleanup";
        }
      }

      impacts.push({
        caller_id: caller.id,
        behavior,
        raw_ref: foundRef ?? "—",
        context_snippet: caller.node_context.slice(0, 80),
      });
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          target: node_id,
          targetName,
          impactCount: impacts.length,
          impacts,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// resolve_logic_chain — Follow parents→calls to explain a full business flow
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "resolve_logic_chain",
  {
    start_node_id: z.string().describe("Starting node ID (e.g. a didSet variable or a function)"),
    depth: z.number().default(4).describe("Max chain depth to follow (default 4)"),
  },
  async ({ start_node_id, depth }) => {
    const startNode = findNode(start_node_id);
    if (!startNode) {
      return { content: [{ type: "text" as const, text: `Node not found: ${start_node_id}` }] };
    }

    const chain: { step: number; direction: string; id: string; resolved_context?: string }[] = [];
    const visited = new Set<string>();

    chain.push({ step: 0, direction: "start", id: startNode.id,
      ...(startNode.node_context ? { resolved_context: resolveIndexTags(startNode.node_context, startNode) } : {}),
    });
    visited.add(startNode.id);

    for (const pid of startNode.parents) {
      if (visited.has(pid)) continue;
      visited.add(pid);
      const parent = findNode(pid);
      if (parent) {
        chain.push({ step: 0, direction: "parent", id: parent.id,
          ...(parent.node_context ? { resolved_context: resolveIndexTags(parent.node_context, parent) } : {}),
        });
      }
    }

    let frontier = [...(startNode.calls ?? []), ...(startNode.inits ?? [])];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const nextFrontier: string[] = [];
      for (const callId of frontier) {
        if (visited.has(callId)) continue;
        visited.add(callId);
        const called = findNode(callId);
        if (!called) continue;
        chain.push({ step: d, direction: "calls", id: called.id,
          ...(called.node_context ? { resolved_context: resolveIndexTags(called.node_context, called) } : {}),
        });
        nextFrontier.push(...(called.calls ?? []).slice(0, 3));
      }
      frontier = nextFrontier;
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ startNode: start_node_id, chainLength: chain.length, chain }, null, 2),
      }],
    };
  }
);

server.tool(
  "get_navigation_path",
  { node_id: z.string().describe("Node ID to navigate to") },
  async ({ node_id }) => {
    const node = findNode(node_id);
    if (!node) {
      return { content: [{ type: "text" as const, text: `Node not found: ${node_id}` }] };
    }

    const result: {
      primary: { absPath: string; line: number; col: number };
      extensions?: { absPath: string; line: number; col: number }[];
    } = {
      primary: node.location,
    };

    if (node.locations && node.locations.length > 0) {
      result.extensions = node.locations;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              node_id,
              name: node.name,
              flavor: node.flavor,
              ...result,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_contextual_subgraph",
  {
    query: z.string().describe("Natural language question about the codebase (e.g. 'How does article fetching work?')"),
    max_seeds: z.number().default(5).describe("Max seed nodes to discover"),
    depth: z.number().default(2).describe("Relationship expansion depth"),
    full_source: z.boolean().default(false).describe("If true, return full node data instead of pre-digested node_context"),
  },
  async ({ query, max_seeds, depth, full_source }) => {
    // Load graph into memory if not already loaded
    if (!_graphLoaded) loadGraphIntoMemory();
    if (_graphNodes.length === 0) return notConfiguredResponse();

    const queryTokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    // ── Phase 1: Seed discovery from in-memory graph ──
    const scored: { node: GraphNode; score: number }[] = [];

    for (const node of _graphNodes) {
      let score = 0;
      const haystack = `${node.id} ${node.name} ${node.flavor}`.toLowerCase();
      for (const token of queryTokens) {
        if (haystack.includes(token)) score += 10;
        if (node.name.toLowerCase() === token) score += 50;
        if (node.name.toLowerCase().includes(token)) score += 20;
      }
      if (node.flavor === "class" || node.flavor === "struct" || node.flavor === "protocol") score += 3;
      if (node.flavor === "function" && (node.calls?.length ?? 0) > 0) score += 2;
      if (score > 0) scored.push({ node, score });
    }

    const seeds = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, max_seeds)
      .map((s) => s.node);

    if (seeds.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: "No relevant nodes found for query", query }),
        }],
      };
    }

    // ── Phase 2: Stitch subgraph from seeds ──
    const seedIds = seeds.map((s) => s.id);

    let missingRefs: string[] = [];

    // In-memory BFS expansion from seeds
    const collected = new Set<string>();
    let frontier = new Set(seedIds);
    for (let d = 0; d <= depth; d++) {
      const next = new Set<string>();
      for (const id of frontier) {
        if (collected.has(id)) continue;
        collected.add(id);
        const node = _nodeById.get(id);
        if (!node) { missingRefs.push(id); continue; }
        for (const ref of [...(node.calls ?? []), ...(node.inits ?? []), ...(node.stores ?? [])]) {
          if (!collected.has(ref)) next.add(ref);
        }
        for (const p of node.parents) {
          if (p.includes("::") && !collected.has(p)) next.add(p);
        }
      }
      frontier = next;
    }
    const stitchedNodes = _graphNodes.filter((n) => collected.has(n.id));

    // ── Phase 3: Classify into primary / relationship / shared ──
    const nodeById = new Map(stitchedNodes.map((n) => [n.id, n]));
    // Primary = seeds + their direct parents/calls
    const primaryIds = new Set(seedIds);
    for (const seed of seeds) {
      for (const p of seed.parents) if (nodeById.has(p)) primaryIds.add(p);
      for (const c of seed.calls ?? []) if (nodeById.has(c)) primaryIds.add(c);
      for (const i of seed.inits ?? []) if (nodeById.has(i)) primaryIds.add(i);
    }

    // Shared = targets + multi-referenced
    const sharedIds = new Set<string>();
    const refCounts = new Map<string, number>();
    for (const node of stitchedNodes) {
      if (node.flavor === "target") { sharedIds.add(node.id); continue; }
      for (const ref of [...(node.calls ?? []), ...(node.inits ?? []), ...(node.stores ?? [])]) {
        refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
      }
    }
    for (const [ref, count] of refCounts) {
      if (count >= 2 && nodeById.has(ref)) sharedIds.add(ref);
    }

    function toFragment(id: string) {
      return toTokenOptimizedFragment(id, nodeById, full_source);
    }

    const relationshipIds = new Set(
      stitchedNodes.map((n) => n.id).filter((id) => !primaryIds.has(id) && !sharedIds.has(id))
    );

    const result = [
      { type: "primary", description: "Seed nodes and immediate connections", data: [...primaryIds].map(toFragment) },
      { type: "relationship", description: `Extended paths (depth ${depth})`, data: [...relationshipIds].map(toFragment) },
      { type: "shared", description: "Bridge nodes referenced by multiple fragments + targets", data: [...sharedIds].map(toFragment) },
    ];

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          query,
          mode: "in_memory",
          seedCount: seeds.length,
          seeds: seeds.map((s) => ({ id: s.id, name: s.name, flavor: s.flavor })),
          fragments: result,
          stats: { primary: result[0].data.length, relationship: result[1].data.length, shared: result[2].data.length, total: result[0].data.length + result[1].data.length + result[2].data.length },
          ...(missingRefs.length > 0 ? { missingFragments: missingRefs } : {}),
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "generate_subgraph_files",
  {
    query: z.string().describe("Natural language question to generate sub-graph files for"),
    max_seeds: z.number().default(5).describe("Max seed nodes"),
    depth: z.number().default(2).describe("Dependency expansion depth"),
  },
  async ({ query, max_seeds, depth }) => {
    const paths = resolveProjectPaths();
    if (!paths) return notConfiguredResponse();
    const { generateSubGraph } = await import("./subgraph-agent.js");
    const outputBase = paths.contextsDir;
    const result = generateSubGraph(paths.graphPath, query, outputBase, max_seeds, depth);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

server.tool(
  "load_context_fragments",
  {
    query_id: z.string().optional().describe("Specific query ID folder to load from. If omitted, loads the latest."),
    fragment_type: z.enum(["primary", "dependency", "shared", "all"]).default("primary").describe("Which fragment to load"),
  },
  async ({ query_id, fragment_type }) => {
    const paths = resolveProjectPaths();
    if (!paths) {
      return notConfiguredResponse();
    }

    const contextsDir = paths.contextsDir;
    if (!fs.existsSync(contextsDir)) {
      return {
        content: [{
          type: "text" as const,
          text: "No context fragments found. Run generate_subgraph_files first, or run ./run.sh.",
        }],
      };
    }

    let targetDir: string;
    if (query_id) {
      targetDir = path.join(contextsDir, query_id);
    } else {
      const dirs = fs.readdirSync(contextsDir)
        .filter((d) => fs.statSync(path.join(contextsDir, d)).isDirectory())
        .sort((a, b) => {
          const aStat = fs.statSync(path.join(contextsDir, a));
          const bStat = fs.statSync(path.join(contextsDir, b));
          return bStat.mtimeMs - aStat.mtimeMs;
        });
      if (dirs.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No sub-graph fragments generated yet. Call generate_subgraph_files first.",
          }],
        };
      }
      targetDir = path.join(contextsDir, dirs[0]);
    }

    if (!fs.existsSync(targetDir)) {
      return {
        content: [{
          type: "text" as const,
          text: `Fragment folder not found: ${targetDir}`,
        }],
      };
    }

    const result: Record<string, GraphNode[]> = {};
    const typesToLoad = fragment_type === "all"
      ? ["primary", "dependency", "shared_commons"]
      : [fragment_type === "shared" ? "shared_commons" : fragment_type];

    for (const prefix of typesToLoad) {
      const filePath = path.join(targetDir, `${prefix}.json`);
      if (fs.existsSync(filePath)) {
        result[prefix] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          folder: targetDir,
          loaded: Object.keys(result),
          stats: Object.fromEntries(
            Object.entries(result).map(([k, v]) => [k, v.length])
          ),
          data: result,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// search_symbols — Find node IDs by name/flavor query
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "search_symbols",
  {
    query: z.string().describe("Search term (e.g. 'intensity', 'BlurEffect', 'didSet')"),
    flavor: z.string().optional().describe("Filter by flavor (class, function, variable, etc.)"),
    limit: z.number().default(10).describe("Max results"),
  },
  async ({ query, flavor, limit }) => {
    if (!_graphLoaded) loadGraphIntoMemory();

    // Prefer indexed SQL search when SQLite SoT is open.
    if (_graphDb) {
      const results = _graphDb.searchSymbols(query, flavor, limit);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ query, resultCount: results.length, source: "sqlite", results }, null, 2),
        }],
      };
    }

    const loader = getFragmentLoader();
    const queryLower = query.toLowerCase();
    const results: { id: string; name: string; flavor: string; context: string | null }[] = [];

    if (loader) {
      loader.forEachFragment((nodes) => {
        for (const n of nodes) {
          if (results.length >= limit) return;
          if (flavor && n.flavor !== flavor) continue;
          const haystack = `${n.id} ${n.name}`.toLowerCase();
          if (haystack.includes(queryLower)) {
            results.push({ id: n.id, name: n.name, flavor: n.flavor, context: n.node_context ?? null });
          }
        }
      });
    } else {
      const data = loadGraph();
      if (data) {
        for (const n of data.nodes) {
          if (results.length >= limit) break;
          if (flavor && n.flavor !== flavor) continue;
          const haystack = `${n.id} ${n.name}`.toLowerCase();
          if (haystack.includes(queryLower)) {
            results.push({ id: n.id, name: n.name, flavor: n.flavor, context: n.node_context ?? null });
          }
        }
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ query, resultCount: results.length, source: "json", results }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// get_logical_cluster — Node + immediate neighborhood with resolved contexts
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_logical_cluster",
  {
    node_id: z.string().describe("Center node ID"),
  },
  async ({ node_id }) => {
    const node = findNode(node_id);
    if (!node) {
      return { content: [{ type: "text" as const, text: `Node not found: ${node_id}` }] };
    }

    // The center node with resolved context
    const center = {
      ...toTokenOptimized(node),
      ...(node.node_context ? { resolved_context: resolveIndexTags(node.node_context, node) } : {}),
    };

    // Immediate neighbors: parents, calls, inits, deinits — each with their own context
    const neighbors: { id: string; relation: string; name: string; flavor: string; context: string | null }[] = [];

    for (const pid of node.parents) {
      const p = findNode(pid);
      if (p) neighbors.push({ id: p.id, relation: "parent", name: p.name, flavor: p.flavor, context: p.node_context ?? null });
    }
    for (const cid of node.calls ?? []) {
      const c = findNode(cid);
      if (c) neighbors.push({ id: c.id, relation: "calls", name: c.name, flavor: c.flavor, context: c.node_context ?? null });
    }
    for (const iid of node.inits ?? []) {
      const i = findNode(iid);
      if (i) neighbors.push({ id: i.id, relation: "init", name: i.name, flavor: i.flavor, context: i.node_context ?? null });
    }
    for (const did of node.deinits ?? []) {
      const d = findNode(did);
      if (d) neighbors.push({ id: d.id, relation: "deinit", name: d.name, flavor: d.flavor, context: d.node_context ?? null });
    }

    // Also find who calls this node (reverse)
    const callers = findCallers(node_id).slice(0, 5);
    for (const caller of callers) {
      neighbors.push({ id: caller.id, relation: "called_by", name: caller.name, flavor: caller.flavor, context: caller.node_context ?? null });
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ center, neighborCount: neighbors.length, neighbors }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// get_project_summary — High-level overview for token-efficient entry point
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_project_summary",
  {},
  async () => {
    if (!_graphLoaded) loadGraphIntoMemory();

    if (_graphDb) {
      const flavorCounts = _graphDb.flavorCounts();
      const targets = _graphDb.targets();
      const totalNodes = _graphDb.nodeCount();
      const meta = loadMetaSummaries();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            source: "sqlite",
            sqlite: path.basename(_graphDb.dbPath),
            schemaVersion: _graphDb.meta("schemaVersion"),
            generatedAt: _graphDb.meta("generatedAt"),
            totalNodes,
            edgeCount: _graphDb.edgeCount(),
            flavorCounts,
            targets,
            ...(meta
              ? {
                  fileSummaryCount: Object.keys(meta.files).length,
                  targetSummaryCount: Object.keys(meta.targets).length,
                }
              : {}),
          }, null, 2),
        }],
      };
    }

    const loader = getFragmentLoader();

    // Count by flavor
    const flavorCounts: Record<string, number> = {};
    const targets: { id: string; name: string; origin: string | null; context: string | null }[] = [];
    let totalNodes = 0;

    if (loader) {
      loader.forEachFragment((nodes) => {
        for (const n of nodes) {
          totalNodes++;
          flavorCounts[n.flavor] = (flavorCounts[n.flavor] ?? 0) + 1;
          if (n.flavor === "target") {
            targets.push({ id: n.id, name: n.name, origin: n.origin ?? null, context: n.node_context ?? null });
          }
        }
      });
    } else {
      const data = loadGraph();
      if (!data) {
        return { content: [{ type: "text" as const, text: NOT_CONFIGURED_MSG }] };
      }
      for (const n of data.nodes) {
        totalNodes++;
        flavorCounts[n.flavor] = (flavorCounts[n.flavor] ?? 0) + 1;
        if (n.flavor === "target") {
          targets.push({ id: n.id, name: n.name, origin: n.origin ?? null, context: n.node_context ?? null });
        }
      }
    }

    // Load file summaries if available
    const meta = loadMetaSummaries();

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          totalNodes,
          flavorCounts,
          targets,
          fileSummaryCount: meta ? Object.keys(meta.files).length : 0,
          _workflow: "Start here. Use search_symbols to find specific nodes. Use get_logical_cluster for a node and its neighborhood. Use get_node_info for individual node details.",
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// get_smart_context — On-demand fragmentation: fetch target nodes + neighbors
//                     with shared-node deduplication and resolved indices
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "get_smart_context",
  {
    target_ids: z.array(z.string()).describe("List of node IDs to build context for"),
    depth: z.number().default(1).describe("Neighbor expansion depth (default 1)"),
  },
  async ({ target_ids, depth }) => {
    if (!_graphLoaded) loadGraphIntoMemory();
    if (_graphNodes.length === 0) return notConfiguredResponse();

    // Phase 1: Collect target nodes + recursive neighbors
    const collected = new Map<string, GraphNode>();
    const refCounts = new Map<string, number>(); // track how many targets reference each node

    for (const targetId of target_ids) {
      const frontier = [targetId];
      const visited = new Set<string>();

      for (let d = 0; d <= depth; d++) {
        const nextFrontier: string[] = [];
        for (const id of frontier) {
          if (visited.has(id)) continue;
          visited.add(id);
          const node = _nodeById.get(id);
          if (!node) continue;
          collected.set(id, node);
          refCounts.set(id, (refCounts.get(id) ?? 0) + 1);

          if (d < depth) {
            // Expand: calls, inits, deinits, parents
            for (const ref of [...(node.calls ?? []), ...(node.inits ?? []), ...(node.deinits ?? [])]) {
              if (!visited.has(ref)) nextFrontier.push(ref);
            }
            for (const p of node.parents) {
              if (p.includes("::") && !visited.has(p)) nextFrontier.push(p);
            }
          }
        }
        frontier.length = 0;
        frontier.push(...nextFrontier);
      }
    }

    // Phase 2: Classify into primary (requested), neighbors, and shared (referenced by 2+ targets)
    const targetSet = new Set(target_ids);
    const primary: Record<string, any>[] = [];
    const neighbors: Record<string, any>[] = [];
    const shared: Record<string, any>[] = [];

    for (const [id, node] of collected) {
      const optimized = toTokenOptimized(node);
      // Auto-resolve index tags
      if (optimized.node_context && /[cdi]\[\d+\]|imp\[\d+\]/.test(optimized.node_context)) {
        optimized.resolved_context = resolveIndexTags(optimized.node_context, node);
      }

      if (targetSet.has(id)) {
        primary.push(optimized);
      } else if ((refCounts.get(id) ?? 0) >= 2) {
        shared.push(optimized);
      } else {
        neighbors.push(optimized);
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          requested: target_ids.length,
          primary: { count: primary.length, nodes: primary },
          neighbors: { count: neighbors.length, nodes: neighbors },
          shared_dependencies: { count: shared.length, nodes: shared },
          total: collected.size,
        }, null, 2),
      }],
    };
  }
);

async function main() {
  // CRITICAL: Never call process.exit(). The server must stay alive
  // to keep the MCP connection green, even if data is missing.
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    const mode = STEALTH_MODE ? "stealth" : "standard";
    console.error(`[SwiftPrism MCP] Connected (mode: ${mode})`);

    const paths = resolveProjectPaths();
    if (paths) {
      // Load graph into memory at startup
      loadGraphIntoMemory();

      // Watch for changes and reload
      try {
        fs.watch(path.dirname(paths.graphPath), (_event: string, filename: string | null) => {
          if (filename === path.basename(paths!.graphPath)) {
            console.error("[SwiftPrism MCP] Graph file changed — reloading into memory...");
            loadGraphIntoMemory();
          }
        });
        console.error(`[SwiftPrism MCP] Watching: ${paths.graphPath}`);
      } catch {
        console.error("[SwiftPrism MCP] Could not watch graph file (non-fatal).");
      }
    } else {
      console.error("[SwiftPrism MCP] No graph data found. Tools will return guidance when called.");
      console.error("[SwiftPrism MCP] Run ./run.sh in the project root to generate data.");
    }
  } catch (err) {
    // Log but do NOT exit — keep the process alive for reconnection attempts
    console.error("[SwiftPrism MCP] Initialization error (non-fatal):", err);
  }
}

main().catch((err) => {
  // Last resort — log but never exit
  console.error("[SwiftPrism MCP] Fatal startup error:", err);
});
