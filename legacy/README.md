# legacy/

Early prototypes from before Hivecode's current architecture. Kept for reference
and history only — **not used by the product**.

The shipped system is:
- [`server.js`](../server.js) — the relay
- [`sync.js`](../sync.js) / [`core.js`](../core.js) — the sync engine
- [`token.js`](../token.js) — access tokens & path scoping
- [`hive-mcp.js`](../hive-mcp.js) — the MCP server agents join through
- [`extension/`](../extension/) — the VS Code / Cursor / Windsurf extension

These files (lock negotiation, lease/merge experiments, the standalone agent and
client demos) explored ideas that were superseded by the CRDT + relay approach.
Safe to ignore; safe to delete.
