---
'watch-tail': minor
---

Add a headless **MCP server**, so an agent can search CloudWatch and the local archive directly
instead of calling AWS itself. `watch-tail mcp` speaks the Model Context Protocol over stdio (through
[tmcp](https://tmcp.io), including the stateless `2026-07-28` revision), starting a private
watch-tail on a free loopback port and stopping it when the agent disconnects. It offers
`archive_status`, `list_log_groups`, `search_logs`, `count_logs` and `get_identity`. Searches default
to `source="cloudwatch"`, which reads the local DuckDB archive first and only calls AWS for the
ranges it does not hold; `source="archive"` stays entirely local, with no AWS calls and no 14-day
limit. Results come back oldest first, capped by `limit` on either source. The private server
releases the archive file between tool calls, so an open agent session does not lock the browser UI
out of the archive.

`watch-tail mcp init` auto-detects installed agents (Claude Desktop, Claude Code, Cursor, Windsurf,
VS Code, Gemini CLI and the Codex CLI), lists them, and merges a `watch-tail` server into each
selected config without disturbing anything else in the file, including settings you added to the
`watch-tail` entry itself (such as an `env`). Files are replaced atomically and keep their
permissions. `--yes`, `--agent`, `--scope`,
`--print`, `--command` and `--args` cover scripted and local-build setups.
