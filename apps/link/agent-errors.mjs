// Sign-in failures of the local CLIs (agents.mjs), including Claude Code's "Failed to authenticate: OAuth session
// expired …", Gemini CLI's "Please set an Auth method …" and Cursor's "… run `agent login`".
export const AUTH_ERROR = /not logged in|not signed in|not authenticated|no authentication|set an auth method|run .?(cursor-)?agent login|copilot login|please (log|sign) in|authentication required|unauthorized|invalid api key|login required|token (has )?expired|failed to authenticate|(oauth|login) session (has )?expired|could not be refreshed/i;

/** The first line of the CLI's own error, for the room. Anything that looks like a key or token is removed. */
export function failureReason(text) {
  const line = String(text ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  return line.replace(/\b(sk-[\w-]{8,}|saw_[\w-]{8,}|eyJ[\w.-]{20,})/g, '[redacted]').slice(0, 300);
}
