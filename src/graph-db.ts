/**
 * graph-db.ts — SQLite SoT for SwiftPrism graphs (hybrid with JSON).
 *
 * On disk: `.swiftprism/graph.sqlite` (gitignored with the rest of .swiftprism).
 * JSON (`prism-context.json`) remains the analyzer / webview interchange format.
 * MCP prefers SQLite when present; falls back to JSON and can import on the fly.
 */
import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import type { GraphNode } from "./fragment-store.js";

export const GRAPH_DB_FILENAME = "graph.sqlite";
export const SCHEMA_VERSION = "1";

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  flavor TEXT NOT NULL,
  abs_path TEXT,
  line INTEGER,
  col INTEGER,
  extends TEXT,
  origin TEXT,
  node_context TEXT,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
);

CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_flavor ON nodes(flavor);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(abs_path);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
`;

export function sqlitePathBesideGraph(graphPath: string): string {
  return path.join(path.dirname(graphPath), GRAPH_DB_FILENAME);
}

export function openGraphDb(dbPath: string, readonly = false): DatabaseSync {
  const db = new DatabaseSync(dbPath, readonly ? { readOnly: true } : {});
  if (!readonly) {
    db.exec(DDL);
  }
  return db;
}

function edgeRows(node: GraphNode): { src: string; dst: string; kind: string }[] {
  const rows: { src: string; dst: string; kind: string }[] = [];
  for (const dst of node.calls ?? []) rows.push({ src: node.id, dst, kind: "call" });
  for (const dst of node.inits ?? []) rows.push({ src: node.id, dst, kind: "init" });
  for (const dst of node.deinits ?? []) rows.push({ src: node.id, dst, kind: "deinit" });
  for (const dst of node.parents ?? []) rows.push({ src: node.id, dst, kind: "parent" });
  for (const dst of node.implements ?? []) rows.push({ src: node.id, dst, kind: "implements" });
  for (const dst of node.stores ?? []) rows.push({ src: node.id, dst, kind: "stores" });
  if (node.extends) rows.push({ src: node.id, dst: node.extends, kind: "extends" });
  return rows;
}

export function parseGraphJson(raw: string): GraphNode[] {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.nodes ?? [];
}

/** Rebuild SQLite from a prism-context / graph JSON file. */
export function importGraphFromJson(
  graphPath: string,
  dbPath = sqlitePathBesideGraph(graphPath)
): { dbPath: string; nodeCount: number; edgeCount: number } {
  if (!fs.existsSync(graphPath)) {
    throw new Error(`graph JSON not found: ${graphPath}`);
  }
  const nodes = parseGraphJson(fs.readFileSync(graphPath, "utf-8"));

  const tmp = `${dbPath}.tmp`;
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const db = openGraphDb(tmp, false);

  const insertMeta = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
  const insertNode = db.prepare(
    `INSERT INTO nodes(id, name, flavor, abs_path, line, col, extends, origin, node_context, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO edges(src, dst, kind) VALUES (?, ?, ?)"
  );

  let edgeCount = 0;
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM edges; DELETE FROM nodes; DELETE FROM meta;");
    insertMeta.run("schemaVersion", SCHEMA_VERSION);
    insertMeta.run("generatedAt", new Date().toISOString());
    insertMeta.run("sourceGraph", path.basename(graphPath));

    for (const node of nodes) {
      const loc = node.location ?? { absPath: "", line: 0, col: 0 };
      insertNode.run(
        node.id,
        node.name,
        node.flavor,
        loc.absPath ?? null,
        loc.line ?? null,
        loc.col ?? null,
        node.extends ?? null,
        node.origin ?? null,
        node.node_context ?? null,
        JSON.stringify(node)
      );
      for (const e of edgeRows(node)) {
        insertEdge.run(e.src, e.dst, e.kind);
        edgeCount++;
      }
    }
    insertMeta.run("nodeCount", String(nodes.length));
    insertMeta.run("edgeCount", String(edgeCount));
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    db.close();
    throw err;
  }

  db.close();
  fs.renameSync(tmp, dbPath);
  return { dbPath, nodeCount: nodes.length, edgeCount };
}

export function rowToNode(row: {
  id: string;
  name: string;
  flavor: string;
  abs_path: string | null;
  line: number | null;
  col: number | null;
  extends: string | null;
  origin: string | null;
  node_context: string | null;
  json: string;
}): GraphNode {
  try {
    return JSON.parse(row.json) as GraphNode;
  } catch {
    return {
      id: row.id,
      name: row.name,
      flavor: row.flavor,
      location: {
        absPath: row.abs_path ?? "",
        line: row.line ?? 0,
        col: row.col ?? 0,
      },
      parents: [],
      extends: row.extends,
      origin: row.origin ?? undefined,
      node_context: row.node_context ?? undefined,
    };
  }
}

export class GraphDatabase {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(dbPath: string, readonly = true) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`SQLite graph not found: ${dbPath}`);
    }
    this.dbPath = dbPath;
    this.db = openGraphDb(dbPath, readonly);
  }

  close(): void {
    this.db.close();
  }

  meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  nodeCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number };
    return row.c;
  }

  edgeCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM edges").get() as { c: number };
    return row.c;
  }

  getNode(id: string): GraphNode | undefined {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as any;
    return row ? rowToNode(row) : undefined;
  }

  getNodes(ids: string[]): GraphNode[] {
    const out: GraphNode[] = [];
    const stmt = this.db.prepare("SELECT * FROM nodes WHERE id = ?");
    for (const id of ids) {
      const row = stmt.get(id) as any;
      if (row) out.push(rowToNode(row));
    }
    return out;
  }

  /** Who points at this node via call/init/deinit. */
  findCallers(targetId: string): GraphNode[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT n.* FROM edges e
         JOIN nodes n ON n.id = e.src
         WHERE e.dst = ? AND e.kind IN ('call','init','deinit')`
      )
      .all(targetId) as any[];
    return rows.map(rowToNode);
  }

  searchSymbols(query: string, flavor: string | undefined, limit: number): {
    id: string;
    name: string;
    flavor: string;
    context: string | null;
  }[] {
    const q = `%${query.toLowerCase()}%`;
    const sql = flavor
      ? `SELECT id, name, flavor, node_context FROM nodes
         WHERE flavor = ? AND (LOWER(id) LIKE ? OR LOWER(name) LIKE ?)
         LIMIT ?`
      : `SELECT id, name, flavor, node_context FROM nodes
         WHERE LOWER(id) LIKE ? OR LOWER(name) LIKE ?
         LIMIT ?`;
    const rows = (
      flavor
        ? this.db.prepare(sql).all(flavor, q, q, limit)
        : this.db.prepare(sql).all(q, q, limit)
    ) as { id: string; name: string; flavor: string; node_context: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      flavor: r.flavor,
      context: r.node_context,
    }));
  }

  flavorCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT flavor, COUNT(*) AS c FROM nodes GROUP BY flavor")
      .all() as { flavor: string; c: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.flavor] = r.c;
    return out;
  }

  targets(): { id: string; name: string; origin: string | null; context: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, origin, node_context FROM nodes WHERE flavor = 'target' ORDER BY name`
      )
      .all() as { id: string; name: string; origin: string | null; node_context: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      origin: r.origin,
      context: r.node_context,
    }));
  }

  /** Load all nodes into memory maps (compat layer for existing MCP helpers). */
  loadAllIntoMemory(): {
    nodes: GraphNode[];
    nodeById: Map<string, GraphNode>;
    callerIndex: Map<string, string[]>;
  } {
    const rows = this.db.prepare("SELECT * FROM nodes").all() as any[];
    const nodes = rows.map(rowToNode);
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const callerIndex = new Map<string, string[]>();
    const edgeRows = this.db
      .prepare(`SELECT src, dst FROM edges WHERE kind IN ('call','init','deinit')`)
      .all() as { src: string; dst: string }[];
    for (const e of edgeRows) {
      const arr = callerIndex.get(e.dst) ?? [];
      arr.push(e.src);
      callerIndex.set(e.dst, arr);
    }
    return { nodes, nodeById, callerIndex };
  }
}

/** CLI: node dist/graph-db.js import <graph.json> [out.sqlite] */
async function mainCli() {
  const [cmd, graphPath, outPath] = process.argv.slice(2);
  if (cmd !== "import" || !graphPath) {
    console.error("Usage: node dist/graph-db.js import <prism-context.json> [graph.sqlite]");
    process.exit(2);
  }
  const result = importGraphFromJson(graphPath, outPath);
  console.log(
    `SQLite graph: nodes=${result.nodeCount} edges=${result.edgeCount} → ${result.dbPath}`
  );
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]).includes(`${path.sep}graph-db.`);

if (isDirect) {
  mainCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
