# mcp-prism

**Language-agnostic MCP server** for Code Prism. Reads **SoT only** — does not parse Swift/Kotlin/JS/Marlin.

Any `*-prism` backend writes SoT; this server exposes the same MCP tools for every language.

## SoT

```text
<project>/.codeprism/          # preferred
  prism-context.json
  graph.sqlite                 # preferred for queries
  codeprism-config.json

<project>/.swiftprism/         # legacy (Swift)
```

## Run

```bash
npm install
npm run build
# from a project that already has SoT:
PRISM_CWD=/path/to/project node dist/server.js
```

MCP config example:

```json
{
  "mcpServers": {
    "mcp-prism": {
      "command": "node",
      "args": ["/path/to/mcp-prism/dist/server.js"],
      "env": { "PRISM_CWD": "/path/to/your/project" }
    }
  }
}
```

## Related

Backends (local: `~/Documents/Code/code-prism/backends/`):

| Repo | Role |
|------|------|
| [swift-prism](https://github.com/jokerphuongnam/swift-prism) | Swift → SoT |
| [marlin-prism](https://github.com/jokerphuongnam/marlin-prism) | Marlin → SoT |
| [kotlin-prism](https://github.com/jokerphuongnam/kotlin-prism) | Kotlin → SoT |
| [js-prism](https://github.com/jokerphuongnam/js-prism) | JS/TS → SoT |
| [rust-prism](https://github.com/jokerphuongnam/rust-prism) | Rust → SoT |
| [go-prism](https://github.com/jokerphuongnam/go-prism) | Go → SoT |
| [code-prism-app-mac](https://github.com/jokerphuongnam/code-prism-app-mac) | macOS UI |
| [code-prism-vs-code](https://github.com/jokerphuongnam/code-prism-vs-code) | VS Code extension |
