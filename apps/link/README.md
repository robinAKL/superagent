# Super Agent Link

On Windows, Link opens the workspace in the browser on first run. The person using the computer signs in with
their own account and chooses **Allow**; no administrator is needed at that computer. The computer then belongs
to that member: they see and can revoke only computers they paired, and can bind only digital employees they own.
Administrators see and manage every computer. Then open **Set up local agent** in the tray menu. If Codex or Claude Code
is missing, choose **安装并登录**. Link runs the official installer, opens that client's sign-in window, and continues
after the command line reports a signed-in account. Then choose a project folder. When both clients are already
signed in, Link asks which to use. The folder path and executable stay on the computer. Link reports the project
label and agent type to the workspace.

In **Admin settings → Linked computers**, bind the project to a digital employee. If there is one available
employee and one project, both are selected automatically. In the Command room, mention that employee to assign
work. The employee card shows whether the binding is ready, the device is offline, or sign-in is required.

### Manual setup

Run from a machine with Node.js 22+ and an authenticated Codex or Claude Code CLI. Link opens the sign-in and pairing page on first run, then stores its worker credential locally. For an existing manually registered worker, set `SUPERAGENT_WORKER_TOKEN` in the Link process environment instead.

An administrator authorizes room dispatch by setting the worker's `roomAssignments` capability to pairs of `projectId` and `employeeId`. Supply it in `capabilities` when registering a worker or as the `roomAssignments` field on `PATCH /api/v1/workers/:id` after pairing. Configure the same project IDs on the local machine. Dispatch uses the single worker bound to a pair and observes employee and project restrictions.

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

The Windows desktop wrapper reads `link-runtime.json` from its per-user data directory (`%LOCALAPPDATA%\SuperAgentLink`). Without that file it maintains presence only. Keep the state file in an account-private directory. By default Link puts `worker-state.json` next to the configuration. It stores the last event cursor, pending jobs, and CLI session IDs. Only run one Link process for a worker. When a task fails because the agent CLI is signed out (for example an expired Claude Code session), the Windows tray shows a notification and opens that CLI's own sign-in (`claude auth login` or `codex login`). After the sign-in succeeds, the tray restarts Link and the waiting task runs again. If the sign-in is closed, choose **Sign in again** in the tray menu. Without the tray, sign in to the CLI and restart Link to retry the task. Ctrl+C stops Link and attempts to cancel the running process tree.

CLI protocol references [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive) and [Claude Code programmatic usage](https://code.claude.com/docs/en/headless).
