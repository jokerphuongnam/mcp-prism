#!/usr/bin/env node
/**
 * Smoke-test mcp-prism over stdio.
 *
 *   node scripts/mcp-smoke.mjs --cwd /path/to/project [--lang marlin]
 *   node scripts/mcp-smoke.mjs --cwd LiteTrace   # if short name resolvable via env project
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.resolve(__dirname, "../dist/server.js");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") out.cwd = path.resolve(argv[++i]);
    else if (a === "--lang") out.lang = argv[++i];
    else if (a === "--ask") out.ask = argv[++i];
    else out._.push(a);
  }
  return out;
}

function summarize(text, max = 900) {
  if (typeof text !== "string") text = JSON.stringify(text, null, 2);
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… (${text.length} chars)`;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content || [])
    .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
  return { isError: !!res.isError, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd || process.cwd();
  const env = {
    ...process.env,
    PRISM_CWD: cwd,
  };
  if (args.lang) env.CODE_PRISM_LANG = args.lang;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env,
    stderr: "pipe",
  });

  const stderrChunks = [];
  transport.stderr?.on("data", (buf) => {
    stderrChunks.push(buf.toString());
  });

  const client = new Client({ name: "mcp-smoke", version: "0.1.0" });
  const results = [];
  const pass = (name, detail) => {
    results.push({ ok: true, name, detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const fail = (name, detail) => {
    results.push({ ok: false, name, detail });
    console.error(`FAIL  ${name} — ${detail}`);
  };

  try {
    await client.connect(transport);
    pass("connect", `PRISM_CWD=${cwd}`);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    pass("tools/list", `${names.length} tools`);
    const required = [
      "get_project_summary",
      "search_symbols",
      "resolve_symbol",
      "ask_graph",
      "get_node_info",
      "get_smart_context",
    ];
    for (const r of required) {
      if (names.includes(r)) pass(`has:${r}`);
      else fail(`has:${r}`, "missing");
    }

    // get_project_summary
    {
      const r = await call(client, "get_project_summary");
      if (r.isError) fail("get_project_summary", r.text);
      else {
        let parsed;
        try {
          parsed = JSON.parse(r.text);
        } catch {
          parsed = null;
        }
        const nodeHint =
          parsed?.totalNodes ??
          parsed?.nodeCount ??
          parsed?.nodes ??
          (Array.isArray(parsed?.flavors) ? "flavors" : null);
        pass(
          "get_project_summary",
          typeof nodeHint === "number"
            ? `nodes≈${nodeHint}`
            : `ok (${typeof parsed})`
        );
        console.log(summarize(r.text, 500));
      }
    }

    // search_symbols
    const searchQ = args.ask?.split(/\s+/)[0] || "ContentView";
    let topId = null;
    {
      const r = await call(client, "search_symbols", { query: searchQ, limit: 5 });
      if (r.isError) fail("search_symbols", r.text);
      else {
        let parsed;
        try {
          parsed = JSON.parse(r.text);
        } catch {
          parsed = null;
        }
        const hits = parsed?.results ?? parsed?.hits ?? parsed?.candidates ?? parsed?.symbols;
        const n = Array.isArray(hits) ? hits.length : 0;
        if (n > 0) {
          topId = hits[0].id || hits[0].node_id || hits[0].symbol;
          pass("search_symbols", `${n} hits, top=${topId}`);
        } else {
          // empty may still be valid for sparse graphs
          fail("search_symbols", `0 hits for '${searchQ}': ${summarize(r.text, 200)}`);
        }
        console.log(summarize(r.text, 400));
      }
    }

    // resolve_symbol
    {
      const r = await call(client, "resolve_symbol", {
        query: searchQ,
        limit: 5,
        auto_pick: true,
        depth: 1,
      });
      if (r.isError) fail("resolve_symbol", r.text);
      else {
        let parsed;
        try {
          parsed = JSON.parse(r.text);
        } catch {
          parsed = null;
        }
        if (parsed?.resolved) {
          topId = parsed.top?.id || topId;
          pass("resolve_symbol", `top=${parsed.top?.id || parsed.top?.name}`);
        } else {
          fail("resolve_symbol", summarize(r.text, 240));
        }
        console.log(summarize(r.text, 400));
      }
    }

    // ask_graph
    const ask = args.ask || `${searchQ} body`;
    {
      const r = await call(client, "ask_graph", { ask, depth: 1, limit: 5 });
      if (r.isError) fail("ask_graph", r.text);
      else {
        let parsed;
        try {
          parsed = JSON.parse(r.text);
        } catch {
          parsed = null;
        }
        if (parsed?.resolved) {
          topId = parsed.top?.id || topId;
          pass("ask_graph", `top=${parsed.top?.id}`);
        } else {
          fail("ask_graph", summarize(r.text, 240));
        }
        console.log(summarize(r.text, 400));
      }
    }

    if (topId) {
      const r = await call(client, "get_node_info", { node_id: topId });
      if (r.isError || /not found/i.test(r.text)) fail("get_node_info", r.text);
      else pass("get_node_info", topId);

      const r2 = await call(client, "get_smart_context", {
        target_ids: [topId],
        depth: 1,
      });
      if (r2.isError) fail("get_smart_context", r2.text);
      else pass("get_smart_context", `${r2.text.length} chars`);
      console.log(summarize(r2.text, 400));
    } else {
      fail("get_node_info", "no topId from prior tools");
      fail("get_smart_context", "skipped");
    }
  } catch (err) {
    fail("fatal", err?.stack || String(err));
  } finally {
    const errLog = stderrChunks.join("").trim();
    if (errLog) {
      console.error("\n--- server stderr ---");
      console.error(errLog.split("\n").slice(-30).join("\n"));
    }
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n=== summary: ${results.filter((r) => r.ok).length} pass / ${failed.length} fail ===`
  );
  process.exit(failed.length ? 1 : 0);
}

main();
