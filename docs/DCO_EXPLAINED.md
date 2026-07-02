# Deterministic Context Override (DCO)

Hivecode coordinates agents via **Deterministic Context Override (DCO)**. Instead of relying solely on conversational history, Hivecode uses Yjs CRDTs and the Model Context Protocol (MCP) to distribute state:

1. **Decentralized State Sync**: Global project state (e.g., `frontend_status: LOCKED`) is stored in a CRDT map that syncs across WebSockets.
2. **Context Synchronization**: When an agent polls for updates via MCP, the current deterministic state is injected into its system context.
3. **State Consistency**: Because the context receives structured updates from the CRDT map, agents maintain a consistent view of the global project state without relying on sequential conversational prompts.

---

## First Full End-to-End Test Report

**Date:** July 1, 2026  
**Project Room:** `project-echo-gqqwip3`  
**Paradigm:** Leaderless Peer-to-Peer AI Swarm with CRDT State Synchronization  
**Objective:** Prove that multiple independent AI agents can collaborate on a single codebase in real-time without stepping on each other's toes, governed strictly by an injected State Machine (`HIVE_RULES.md` and global JSON state).

### 1. The Swarm Setup
*   **Lead PM:** Antigravity (Autonomous Background Cron Job)
*   **Backend Developer:** `third-agent` (Hermes CLI Agent)
*   **Frontend Developer:** `second-agent` (Hermes CLI Agent)
*   **Infrastructure:** Live CRDT synchronization via Yjs (`hive-mcp.js`), tracking `backend_status`, `frontend_status`, `HIVE_BOARD`, and `HIVE_CHAT`.

### 2. The Initial State
The project started in the `PLANNING` phase. To test the lock mechanism, the PM set the global state to:
*   `backend_status: 'LOCKED'`
*   `frontend_status: 'LOCKED'`

**Result:** Both agents successfully parsed the state and entered a blocked `hive_wait` loop. They acknowledged the lock in the chat and did not attempt to touch any files.

### 3. Phase 1: Backend Implementation
The PM flipped the state to `backend_status: 'APPROVED_TO_BUILD'`. 

**Action:** 
The Backend Agent immediately woke up from its `hive_wait` block. It was assigned the task of building an Express server. It successfully created `server.js` and `store.js`, implementing a full CRUD API for `/api/habits`.

### 4. Unplanned Swarm Collaboration (Merge Conflict)
While the backend was being built, a Yjs merge conflict occurred in `package.json` (due to concurrent `npm install` events). 

**Action:**
Because the Frontend Agent was still `LOCKED` out of its primary task, it was idle. It detected the merge conflict in `package.json` and voluntarily jumped in to help! It resolved the conflict and pushed the clean version, stating in the chat: *"Resolved the merge conflict in package.json... Still waiting for frontend_status to be APPROVED_TO_BUILD before starting frontend work."*

**Result:** The State Machine successfully kept the frontend agent away from the main codebase while still allowing it to perform dynamic P2P problem solving for the swarm.

### 5. Phase 2: State Flip & Frontend Implementation
Once the backend was tested and complete, the autonomous PM flipped the CRDT state:
*   `backend_status: 'COMPLETED'`
*   `frontend_status: 'APPROVED_TO_BUILD'`

**Action:**
The Frontend Agent was unblocked. Upon receiving a direct `hive_assign` command from the PM, it immediately began creating `index.html`, `app.js`, and `style.css` in the `/public` directory. It successfully built a beautiful Vanilla JS interface that consumed the Express API built by the Backend Agent.

### 6. Minor Glitches & Edge Cases
*   **Tool Duplication Glitch:** The Frontend Agent appended the exact same code twice to `app.js` and `index.html`. This was an isolated tool-level glitch with the MCP server file-writer, not a failure of the SMP state machine. It was easily truncated by the PM.
*   **Config Bugs:** We discovered that Hermes configurations failing to load the MCP server will cause the agent to silently drop the tool. The fix was ensuring `config.yaml` used strict YAML arrays rather than stringified JSON arrays.

### 7. Final Conclusion
The test successfully validated the DCO architecture. 

By utilizing CRDT-backed state locks via MCP, the agents were able to coordinate sequentially and resolve merge conflicts in a decentralized room without centralized orchestrator intervention. 

The agents successfully completed the end-to-end implementation of a Full-Stack Habit Tracker application.

**Test Status:** ✅ PASSED
