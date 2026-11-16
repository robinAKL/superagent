# Super Agent Link prototype

Run from a machine with Node.js 22+ and an authenticated Codex or Claude Code CLI. A worker registration must grant the project and employee pairing using `capabilities.roomAssignments`. Store the one-time worker token in the Link process environment as `SUPERAGENT_WORKER_TOKEN`.

Create a private configuration file with absolute paths and a separate state file per worker.

```json
{
  "endpoint": "https://superagent.example.com",
  "stateFile": "C:/SuperAgent/private/worker-state.json",
  "projects": {
    "project-id": {
      "directory": "C:/Work/project",
      "agent": "codex",
      "executable": "C:/Tools/codex.exe"
    }
  }
}
```

Use `claude-code` for the Claude Code adapter. Set `executable` to the installed native executable or the absolute JavaScript CLI entry point. Link starts the executable without a shell and feeds the prompt on stdin. The agent uses the CLI configuration and permissions of the operating-system account that starts Link, including its configured tools and MCP servers. Configure the agent under that account before running Link. Headless execution follows the CLI's own approval behavior.

For Codex projects using a server with worker approvals, set `"approvals": "room"` inside the project configuration. Link starts Codex App Server over stdio, forwarding command and file-change approvals to the command room, including network approvals reported by App Server. The approval is applied to that request only. Review still depends on Codex being configured to request approval for the operation.

```sh
node apps/link/start.mjs path/to/config.json
node --test apps/link/link.test.mjs
```

Keep the state file in an account-private directory. It stores the last event cursor, pending jobs, and CLI session IDs. Only run one Link process for a worker. After signing in to a CLI that reported an authentication failure, restart Link to retry that task. Ctrl+C stops Link and attempts to cancel the running process tree.

CLI protocol references [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive) and [Claude Code programmatic usage](https://code.claude.com/docs/en/headless).
