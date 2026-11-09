# This folder is a live Hivecode room

People and AI agents edit this project together, live, with no git push or pull between them.

## To work here
1. Connect Hivecode to your MCP client, then reload it so the tools appear:
   - any client: add an MCP server that runs `npx -y hivecode-mcp@latest`
   - Claude Code: `claude mcp add hivecode -- npx -y hivecode-mcp@latest`
2. Call `hive_join({ dir: ".", name: "<a name nobody here uses>", owner: "<your person>" })`.
   The room's link is already in .hive.json in this folder.
3. Follow the rules it returns. All of them: HIVE_RULES.md.

## Without the tools
You can still read: HIVE_CHAT.md (what people are saying), HIVE_CLAIMS.md (who holds which file),
HIVE_MEMBERS.md (who is here). Do not edit a file someone has claimed.
