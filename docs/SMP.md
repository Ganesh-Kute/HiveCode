# State-Machine Prompting (SMP) / Cognitive ICR

State-Machine Prompting (SMP) is Hivecode's answer to the "Agent Drift" problem. Just as Intent-aware Code Replication (ICR) mathematically prevents agents from corrupting the codebase, SMP mathematically prevents agents from hallucinating their project state.

## The Problem: Conversational Drift

In traditional multi-agent frameworks (like AutoGen or CrewAI), agents rely on a massive, ever-growing chat history to figure out what they should be doing. 

For example, a PM agent might say in chat: *"The contract is ready. Backend, you may begin."*
The Backend agent reads that chat message, infers its state, and starts coding. 

But as the chat history grows to hundreds of messages, LLMs suffer from "context drift." They forget past instructions, hallucinate their current permissions, or get trapped in conversational loops. Natural language is too subjective to use as a reliable state machine.

## The Solution: Hardware-Level Interrupts for LLMs

Hivecode treats agents like threads in a CPU. Instead of asking them to interpret their state from a chat log, Hivecode uses **Yjs CRDTs (Conflict-Free Replicated Data Types)** to inject a rigid, deterministic state machine directly into their Model Context Protocol (MCP) tool loops.

### How it works technically:

1. **The Shared CRDT Map (`swarm_state`)**
   Hivecode’s synchronization engine maintains a real-time, decentralized key-value map called `swarm_state`. Because it runs on Yjs, any change to this map synchronizes across all connected agents instantly, regardless of where in the world they are running.

2. **The `hive_wait` Cognitive Injection**
   When an agent has no immediate tasks, it calls the `hive_wait` MCP tool to block and listen for work. 
   When the wait loop resolves, the MCP server does not just return new chat messages. It physically reads the `swarm_state` map and **prepends it** to the agent's response payload.

   Every single time an agent checks for work, its prompt context is structurally overridden with an unarguable truth:
   ```json
   [GLOBAL PROJECT STATE]
   {
     "contract": "APPROVED",
     "qa_status": "PENDING"
   }
   ```

3. **Mastermind Control (`hive_set_state`)**
   The Lead PM (or a human) is given a special tool: `hive_set_state`. 
   If the PM uses this tool to set `contract` to `APPROVED`, the CRDT map updates instantly. The next time the Backend agent polls `hive_wait`, it receives the new state and is physically unblocked.

## Why this is a Paradigm Shift

- **Decentralized Coordination:** There is no "master Python script" controlling the agents. The agents run completely independently, and the CRDT math handles the state synchronization.
- **Eradication of Drift:** By aggressively overriding the agent's context window with the physical state of the project, they can run indefinitely without forgetting their role.
- **Cognitive ICR:** If ICR perfectly merges agent *code* by structural intent, SMP perfectly merges agent *cognitive states* by structural intent. They no longer guess; they know.
