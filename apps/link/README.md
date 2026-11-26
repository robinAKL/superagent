# Super Agent Link

On Windows, Link opens the workspace in the browser on first run. The person using the computer signs in with
their own account and chooses **Allow**; no administrator is needed at that computer. The computer then belongs
to that member: they see and can revoke only computers they paired, and can bind only digital employees they own.
Administrators see and manage every computer. Then open **Local clients / 本地客户端** in the tray menu. Each supported
client gets the same three steps: **安装并登录** (Link runs the official installer), **登录** (Link opens that client's
own sign-in and continues once it reports a signed-in account), and **选择项目文件夹**, which connects the client to
the command room. Several clients can be connected at once.

| Client | Install (Windows, run by Link) | Sign-in | Headless run | Approvals |
| --- | --- | --- | --- | --- |
| Claude Code (`claude-code`) | `irm https://claude.ai/install.ps1 \| iex` | `claude auth login` | `--print --output-format stream-json` | each request through the command room |
| Codex (`codex`) | `irm https://chatgpt.com/codex/install.ps1 \| iex` | `codex login` | `exec --json` (or App Server) | Codex config, or the room with `"approvals": "room"` |
| Cursor CLI (`cursor`) | `irm 'https://cursor.com/install?win32=true' \| iex` | `agent login` (`agent status`) | `--print --output-format stream-json --trust` | employee mode: `full` adds `--force` |
| GitHub Copilot CLI (`copilot`) | `npm install -g @github/copilot` | `copilot login` | `-p <prompt> -s --no-ask-user` (text) | `standard` `--allow-tool=write`, `full` `--allow-all-tools` |
| Gemini CLI (`gemini`) | `npm install -g @google/gemini-cli` | `gemini` → Sign in with Google | `--output-format stream-json` | `--approval-mode` default / auto_edit / yolo |
| Qwen Code (`qwen`) | `npm install -g @qwen-code/qwen-code` | `qwen` → `/auth` | `--output-format stream-json` | `--approval-mode` default / auto-edit / yolo |

The npm installs get Node.js LTS from winget first when npm is missing. Gemini CLI, Qwen Code and Copilot have no
sign-in status command; Link reads their own credential files (`~/.gemini/oauth_creds.json`, `~/.qwen/oauth_creds.json`,
`~/.copilot/config.json`) or a token in the environment. For Cursor, Copilot, Gemini and Qwen the employee's
authorisation mode (strict / standard / full) becomes the client's own approval setting; their requests are not
forwarded to the command room one by one. The folder path and executable stay on the computer. Link reports the project
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

Use `claude-code`, `cursor`, `copilot`, `gemini` or `qwen` for the other adapters. Set `executable` to the installed native executable or the absolute JavaScript CLI entry point. Link starts the executable without a shell and feeds the prompt on stdin. The agent uses the CLI configuration and permissions of the operating-system account that starts Link, including its configured tools and MCP servers. Configure the agent under that account before running Link. Headless execution follows the CLI's own approval behavior.

For Codex projects using a server with worker approvals, set `"approvals": "room"` inside the project configuration. Link starts Codex App Server over stdio, forwarding command and file-change approvals to the command room, including network approvals reported by App Server. The approval is applied to that request only. Review still depends on Codex being configured to request approval for the operation.

```sh
node apps/link/start.mjs path/to/config.json
node --test apps/link/link.test.mjs
```

The Windows desktop wrapper reads `link-runtime.json` from its per-user data directory (`%LOCALAPPDATA%\SuperAgentLink`). Without that file it maintains presence only. Keep the state file in an account-private directory. By default Link puts `worker-state.json` next to the configuration. It stores the last event cursor, pending jobs, and CLI session IDs. Only run one Link process for a worker. When a task fails because the agent CLI is signed out (for example an expired Claude Code session), the Windows tray shows a notification and opens that CLI's own sign-in (`claude auth login` or `codex login`). After the sign-in succeeds, the tray restarts Link and the waiting task runs again. If the sign-in is closed, choose **Sign in again** in the tray menu. Without the tray, sign in to the CLI and restart Link to retry the task. Ctrl+C stops Link and attempts to cancel the running process tree.

CLI protocol references [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive) and [Claude Code programmatic usage](https://code.claude.com/docs/en/headless).
