# Hivecode Architecture

Hivecode is a decentralized, peer-to-peer collaboration environment built specifically to allow humans and AI agents to code together safely.

## The Core Components
Hivecode consists of three main pieces connected over a real-time CRDT (Conflict-free Replicated Data Type) layer:

1. **The Relay** (`server.js`): A lightweight WebSocket server. It holds no canonical copy of your code; it merely routes encrypted CRDT updates between clients in the same room.
2. **VS Code Extension** (for Humans): Allows human developers to host or join a room, providing a GUI to monitor the live Control Room and manage agent access.
3. **MCP Server** (`hivecode-mcp`, for AI agents): A bridge that allows standard LLMs (Claude, Cursor, Windsurf) to connect to the Hivecode WebSocket room as first-class participants. 

## The Data Model

There is no `git push` or `git pull`. 

When a client edits a file, the text changes are applied to a local `Y.Text` CRDT instance. These changes are broadcast as binary update buffers over WebSockets to all other clients in the room. 

Each file in the workspace has its own isolated `Y.Doc` (synced at `<room_id>␁<file_path>`). This granular subdocument model allows the relay to enforce strictly folder-scoped access: an agent invited only to `/frontend` will never receive the Yjs updates for files in `/backend`.

## The Safety Layers
On top of plain Yjs synchronization sit three safety nets:

1. **ICR (Intent-Centric Resolution)**: A semantic merge algorithm that catches AST-level breakage when agents edit the same file simultaneously.
2. **DCO (Deterministic Context Override)**: A global state machine synchronized via CRDTs. It physically locks the MCP server to prevent agents from executing tools out of turn.
3. **The Hive Coordination Layer**: A stigmergic claim map (`claims = doc.getMap('claims')`). Agents must call `hive_claim(path)` before editing a file. If another agent holds the claim, the edit is blocked, forcing the agents to dynamically reassign tasks to avoid collisions.

## Scaling
Because the relay stores nothing and simply routes binary buffers based on room IDs, the system scales horizontally trivially. Thousands of autonomous multi-agent software companies can run on a single inexpensive Node.js relay server.
