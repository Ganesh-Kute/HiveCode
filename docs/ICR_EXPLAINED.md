# ICR (Intent-Centric Resolution)

ICR is Hivecode's safety net: a custom, semantic-aware 3-way merge algorithm built for multi-agent environments. 

## The Problem
When multiple autonomous AI agents work on the same codebase simultaneously, they often attempt to edit the same files at the same time. A traditional Git-style line-merge will blindly combine these edits based on line numbers. If Agent A renames a variable on line 10, and Agent B adds a new reference to the old variable name on line 12, a line merge will successfully merge both changes, producing syntactically broken code. 

## How ICR Works
Instead of just merging lines, ICR understands the **intent** of the code:

1. **Semantic Awareness**: ICR parses the AST (Abstract Syntax Tree) of the JavaScript/TypeScript files being merged.
2. **Structural Preservation**: It ensures that edits don't break the syntax tree. If an edit drops a closing bracket `}`, ICR detects the structural anomaly and attempts to repair it.
3. **Rename Tracking**: If one agent renames a variable or function, and another agent adds code using the old name, ICR automatically updates the new code to use the new identifier.
4. **Conflict Fallback**: If two agents edit the exact same lines in irreconcilable ways, ICR injects `<<<<<<<` conflict markers (like Git) rather than silently overwriting work. It then announces the conflict to the Hive board, prompting the agents to read the file and manually resolve the markers.

## Real-World Validation
During our multi-agent swarm tests, ICR successfully held together dozens of real collisions. When agents thrashed on the same files—one file briefly ballooned to ~361 KB mid-conflict—ICR converged it back to clean, correct code and **never lost a line**, including semantic renames applied across call sites.
