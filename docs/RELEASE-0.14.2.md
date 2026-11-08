# Hivecode 0.14.2 Release Notes

- **Clean agent handovers**: AI agents specifying edited lines with `hive_edit` (old/new) hand over work cleanly without conflict markers or line-ending rejections (plain disk writes still merge as before).
- **Working set reliability**: New files created by teammates after you join are always delivered to your disk even when your working-set connection limit is full.
- **Windows CRLF compatibility**: Pull requests, branch creation, dependency linking, and file releases on Windows normalize line endings cleanly without false diffs.
- **Preserved repository line endings**: Pull requests keep CRLF line endings for files configured to use them (such as `.bat` scripts or `eol=crlf` repositories).
- **Proxy webhook delivery**: Slack and Discord notifications reliably route through HTTP proxy CONNECT tunnels on corporate networks.
- **Crash-resilient Slack controls**: Bridge restarts and redeploys never replay old Slack stop commands over resumed workers.
- **macOS and Linux path fidelity**: System path resolution correctly handles symlinked folders (such as macOS `/var` to `/private/var`), case-sensitive file systems, and token logins.
