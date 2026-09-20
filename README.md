# mcp-prism

**Language-agnostic MCP** for Code Prism. Points at a **user project**, resolves SoT in the **system cache**, returns data to agents.

Does **not** parse languages. Does **not** write into the user project.

## Flow

```text
Agent  →  mcp-prism  →  ~/Library/Caches/code-prism/<lang>/<key>/
                ↑
         PRISM_CWD=/path/to/user/project
```

Backends (`swift-prism`, `js-prism`, …) analyze the user project **read-only** and write cache entries. MCP only reads that cache.

## Cache layout

See [CACHE.md](../code-prism/CACHE.md) (local umbrella) — summary:

```text
~/Library/Caches/code-prism/
  swift/<projectKey>/meta.json + prism-context.json + graph.sqlite
  js/<projectKey>/…
```

`projectKey` = SHA-256(realpath(project))[:16]

## Run

```bash
npm install && npm run build

# Point at the project you want agents to inspect:
PRISM_CWD=/path/to/user/project CODE_PRISM_LANG=swift node dist/server.js
```

If `CODE_PRISM_LANG` is omitted, MCP picks the first language that has a cache hit.

## MCP config

```json
{
  "mcpServers": {
    "mcp-prism": {
      "command": "node",
      "args": ["/path/to/mcp-prism/dist/server.js"],
      "env": {
        "PRISM_CWD": "/path/to/user/project",
        "CODE_PRISM_LANG": "swift"
      }
    }
  }
}
```

## Related

Backends live under `~/Documents/Code/code-prism/backends/` (each its own git repo):  
swift · marlin · kotlin · js · rust · go · cpp · objective-c  

UIs: [code-prism-app-mac](https://github.com/jokerphuongnam/code-prism-app-mac), [code-prism-vs-code](https://github.com/jokerphuongnam/code-prism-vs-code)
