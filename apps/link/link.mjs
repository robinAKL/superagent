import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchAgent, launchCodexWithApprovals, projectDirectory } from './agent.mjs';
import { DEFAULT_POLICY, cleanPolicy, decide, describe, mcpToolsByServer, parseMcpList } from './policy.mjs';
import { execFile } from 'node:child_process';

/** What a person needs to judge a request, within the room's size limit: long strings (a whole file) are cut. */
function approvalInput(input) {
  const short = (value, depth = 0) => {
    if (typeof value === 'string') return value.length > 800 ? value.slice(0, 800) + '…' : value;
    if (Array.isArray(value)) return depth > 3 ? '…' : value.slice(0, 20).map((item) => short(item, depth + 1));
    if (value && typeof value === 'object') return depth > 3 ? '…' : Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k, short(v, depth + 1)]));
    return value;
  };
  const trimmed = short(input && typeof input === 'object' ? input : {});
  return JSON.stringify(trimmed).length <= 12_000 ? trimmed : { note: 'Input too large to show; see the task on the computer.' };
}

/**
 * `claude mcp list` (name and health) joined with the tools the last run actually had. A server that served tools in
 * that run but is missing from the list (a claude.ai connector) was connected then.
 */
export function withMcpTools(servers, tools) {
  if (!servers && !tools) return null;
  const out = (servers ?? []).map((server) => (tools?.[server.name] ? { ...server, tools: tools[server.name] } : server));
  for (const [name, list] of Object.entries(tools ?? {})) {
    if (!out.some((server) => server.name === name) && out.length < 32) out.push({ name, status: 'connected', tools: list });
  }
  return out;
}

const IDLE_ERROR_DELAY_MS = 2_000;
const FIRST_POLL_RETRY_MS = 1_000;
const MAX_POLL_RETRY_MS = 5_000;
const STATE_TEMP_SUFFIX = '.tmp';
const STATE_RENAME_RETRY_MS = [0, 15, 30, 60, 120, 240];

export class WorkerLink {
  #active = null;
  #state;
  #projects;
  #api;
  #stateFile;
  #launch;
  #launchWithApprovals;
  #sleep;
  #onStatus;
  #onTask;
  #onAuth;
  #onMcpLogin;
  /** While a person signs an MCP server in, its status is checked every minute instead of every hour. */
  #mcpWatchUntil = 0;
  #renameState;
  #stateWrite = Promise.resolve();
  #storageFailure;

  constructor(config, token, {
    fetcher = fetch, launch = launchAgent, launchWithApprovals = launchCodexWithApprovals,
    sleep = delay, onStatus = () => {}, onTask = () => {}, onAuth = () => {}, onMcpLogin = () => {}, renameState = rename,
  } = {}) {
    const endpoint = new URL(config.endpoint);
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Configure a trusted HTTPS endpoint.');
    if (!isAbsolute(config.stateFile) || !token) throw new Error('Configure an absolute stateFile and SUPERAGENT_WORKER_TOKEN.');
    this.#stateFile = config.stateFile;
    this.#projects = new Map(Object.entries(config.projects ?? {}));
    for (const project of this.#projects.values()) {
      if (!['codex', 'claude-code'].includes(project.agent) || !isAbsolute(project.executable)) {
        throw new Error('Each project needs a fixed agent and an absolute executable path.');
      }
    }
    this.#launch = launch;
    this.#launchWithApprovals = launchWithApprovals;
    this.#sleep = sleep;
    this.#onStatus = onStatus;
    this.#onTask = onTask;
    this.#onAuth = onAuth;
    this.#onMcpLogin = onMcpLogin;
    this.#renameState = renameState;
    try { this.#state = JSON.parse(readFileSync(config.stateFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.#state = { cursor: 0, jobs: [] };
    }
    const identity = createHash('sha256').update(endpoint.origin).update('\0').update(token).digest('hex');
    if (this.#state.identity && this.#state.identity !== identity) this.#state = { cursor: 0, jobs: [] };
    this.#state.identity = identity;
    for (const job of this.#state.jobs) {
      if (job.status === 'waiting_auth') job.status = 'queued';
    }
    this.#api = async (path, body, signal) => {
      const response = await fetcher(new URL('/api/v1/worker-link' + path, endpoint), {
        method: 'POST', body: JSON.stringify(body), signal, redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      });
      if (!response.ok) throw Object.assign(new Error('Worker API returned HTTP ' + response.status), { status: response.status });
      return response.json();
    };
  }

  /** MCP servers Claude Code has here, refreshed at start and hourly (the health check takes a few seconds). */
  #mcpServers = null;
  #mcpCheckedAt = 0;

  #refreshMcpServers() {
    if (Date.now() - this.#mcpCheckedAt < (Date.now() < this.#mcpWatchUntil ? 60_000 : 60 * 60_000)) return;
    this.#mcpCheckedAt = Date.now();
    const entry = [...this.#projects.entries()].find(([, project]) => project.agent === 'claude-code');
    if (!entry) return;
    let project;
    try { project = projectDirectory(this.#projects, entry[0]); } catch { return; }
    const command = project.executable.endsWith('.js') || project.executable.endsWith('.mjs') ? process.execPath : project.executable;
    const argv = command === process.execPath ? [project.executable, 'mcp', 'list'] : ['mcp', 'list'];
    const env = { ...process.env };
    delete env.SUPERAGENT_WORKER_TOKEN;
    execFile(command, argv, { cwd: project.directory, env, timeout: 60_000, windowsHide: true }, (error, stdout) => {
      if (!error || stdout) this.#mcpServers = parseMcpList(stdout);
    });
  }

  #capabilities() {
    const projects = [];
    for (const [id, project] of this.#projects) {
      try {
        const directory = projectDirectory(this.#projects, id).directory;
        if (!statSync(project.executable).isFile()) continue;
        projects.push({ id, name: (basename(directory) || id).slice(0, 128), agent: project.agent });
      } catch {
        // A moved folder or executable cannot receive new work until it is available again.
      }
    }
    this.#refreshMcpServers();
    const mcpServers = withMcpTools(this.#mcpServers, this.#state.mcpTools);
    return { projects, agents: [...new Set(projects.map(project => project.agent))], ...(mcpServers ? { mcpServers } : {}) };
  }

  #save() {
    const snapshot = JSON.stringify(this.#state);
    const temporary = this.#stateFile + STATE_TEMP_SUFFIX;
    this.#stateWrite = this.#stateWrite.then(async () => {
      await mkdir(dirname(this.#stateFile), { recursive: true });
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      try {
        for (const wait of STATE_RENAME_RETRY_MS) {
          if (wait) await delay(wait);
          try {
            await this.#renameState(temporary, this.#stateFile);
            return;
          } catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || wait === STATE_RENAME_RETRY_MS.at(-1)) throw error;
          }
        }
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }).catch(error => {
      this.#storageFailure = error;
      throw error;
    });
    return this.#stateWrite;
  }

  #update(job, kind, body) {
    return this.#api('/room-tasks/' + encodeURIComponent(job.id) + '/' + kind, { body }, AbortSignal.timeout(10_000));
  }

  /** A Codex App Server request ({ kind }) or a Claude Code tool call ({ tool, input, summary }) for the room to decide. */
  async #approve(job, request, signal) {
    const codex = typeof request.kind === 'string';
    const summary = codex ? {
      command: 'Codex requests permission to run a command.',
      file_change: 'Codex requests permission to change files.',
      network_access: 'Codex requests permission to access the network.',
    }[request.kind] : request.summary;
    const { approval } = await this.#api('/approvals', {
      roomTaskId: job.id, tool: codex ? 'codex.' + request.kind : request.tool, input: codex ? request : approvalInput(request.input), summary,
    }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    const deadline = typeof approval.expiresAt === 'number' ? approval.expiresAt : Date.parse(approval.expiresAt);
    if (!Number.isFinite(deadline) || typeof approval.id !== 'string') return 'deny';
    while (!signal.aborted && Date.now() < deadline) {
      const waitMs = Math.min(25_000, Math.max(0, deadline - Date.now()));
      try {
        const { approval: latest } = await this.#api('/approvals/' + encodeURIComponent(approval.id) + '/wait', {
          waitMs,
        }, AbortSignal.any([signal, AbortSignal.timeout(waitMs + 5_000)]));
        if (latest.status === 'allowed') return 'allow';
        if (latest.status !== 'pending') return 'deny';
      } catch (error) {
        if ([400, 401, 403, 404, 409].includes(error.status)) return 'deny';
        await delay(IDLE_ERROR_DELAY_MS, undefined, { signal }).catch(() => {});
      }
    }
    return 'deny';
  }

  /** This employee's authorisation on this computer, read fresh for each task; the default when it cannot be read. */
  async #policy(job) {
    try {
      const { policies } = await this.#api('/permissions', {}, AbortSignal.timeout(10_000));
      return cleanPolicy(policies?.[job.projectId]);
    } catch {
      return { ...DEFAULT_POLICY };
    }
  }

  /**
   * The loopback endpoint Claude Code's permission tool calls for this task. It answers from the policy, and passes
   * the requests the policy says to ask about to the command room. Only this task's secret is accepted.
   */
  async #approver(job, policy, signal) {
    const secret = randomBytes(32).toString('hex');
    const seen = new Set();
    const expected = Buffer.from('Bearer ' + secret);
    const server = createServer(async (req, res) => {
      const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const given = Buffer.from(String(req.headers.authorization ?? ''));
      if (req.method !== 'POST' || req.url !== '/approve') return reply(404, {});
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(401, {});
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 256_000) return reply(413, {}); }
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400, {}); }
      const tool = String(body?.tool_name ?? '').slice(0, 128);
      const input = body?.input && typeof body.input === 'object' ? body.input : {};
      if (tool) seen.add(tool);
      const decision = decide(policy, tool);
      if (decision === 'allow') return reply(200, { behavior: 'allow' });
      if (decision === 'deny') return reply(200, { behavior: 'deny', message: 'This action is not allowed on this computer (authorisation settings).' });
      const answer = await this.#approve(job, { tool, input, summary: describe(tool, input) }, signal).catch(() => 'deny');
      reply(200, answer === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'Not approved in the command room (denied or timed out). Report this and stop.' });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address();
    return {
      url: `http://127.0.0.1:${port}/approve`, secret,
      close: () => {
        server.close();
        // The tools this task asked about appear in the room's tool list, each with its own switch.
        if (seen.size) void this.#api('/permissions/seen', { projectId: job.projectId, tools: [...seen] }, AbortSignal.timeout(10_000)).catch(() => {});
      },
    };
  }

  #wake(event) {
    const { roomTaskId, projectId, prompt } = event.payload ?? {};
    const attempt = Number.isSafeInteger(event.payload?.attempt) && event.payload.attempt > 0 ? event.payload.attempt : 0;
    if (typeof roomTaskId !== 'string' || !roomTaskId || typeof projectId !== 'string' || typeof prompt !== 'string'
      || !prompt.trim() || prompt.length > 32_000) return;
    const known = this.#state.jobs.find((job) => job.id === roomTaskId);
    if (!known) {
      this.#state.jobs.push({ id: roomTaskId, projectId, prompt, status: 'queued', attempt });
      return;
    }
    // Super Agent sends the same task again (resumed or retried) with a higher attempt: run it once more. A copy of
    // a wake already taken, or one for a task still queued or running here, changes nothing.
    if (attempt <= (known.attempt ?? 0) || known.status === 'queued' || known.status === 'reporting' || this.#active?.job === known) return;
    Object.assign(known, { projectId, prompt, status: 'queued', attempt });
    delete known.outcome;
  }

  /**
   * The command room asks to sign an MCP server in again. The desktop tray opens Claude Code's MCP sign-in for the
   * person at this computer (Link never types or sees their account); meanwhile the status is checked every minute.
   */
  #mcpLogin(event) {
    const server = event.payload?.server;
    if (typeof server !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(server)) return;
    this.#mcpWatchUntil = Date.now() + 20 * 60_000;
    this.#mcpCheckedAt = 0;
    this.#onMcpLogin(server);
  }

  #cancel(event) {
    const job = this.#state.jobs.find((item) => item.id === event.payload?.roomTaskId);
    if (!job || job.status === 'done') return;
    job.status = 'cancelled';
    delete job.prompt;
    delete job.outcome;
    if (this.#active?.job === job) this.#active.process.cancel();
  }

  async poll(signal, waitMs = 25_000) {
    const { events } = await this.#api('/poll', { since: this.#state.cursor, waitMs, eventsOnly: true }, signal);
    for (const event of events ?? []) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= this.#state.cursor) continue;
      if (event.kind === 'wake') this.#wake(event);
      if (event.kind === 'cancel') this.#cancel(event);
      if (event.kind === 'mcp_login') this.#mcpLogin(event);
      this.#state.cursor = event.seq;
      await this.#save();
    }
  }

  async #finish(job) {
    if (job.status === 'cancelled') return;
    const outcome = job.outcome;
    if (outcome.result) await this.#update(job, 'report', outcome.result);
    else if (outcome.authentication) {
      // Tell the tray first: it opens the CLI's own sign-in and restarts Link, which re-queues this task.
      const agent = this.#projects.get(job.projectId)?.agent;
      if (agent) this.#onAuth(agent);
      await this.#api('/heartbeat', { busy: false, waitingAuthReason: outcome.authentication }, AbortSignal.timeout(10_000));
      await this.#update(job, 'progress', outcome.authentication);
    } else await this.#update(job, 'progress', outcome.failure);
    if (job.status !== 'cancelled') {
      job.status = outcome.authentication ? 'waiting_auth' : 'done';
      if (job.status === 'done') delete job.prompt;
      delete job.outcome;
      await this.#save();
    }
  }

  async runNext(signal) {
    if (this.#active || signal?.aborted) return;
    const job = this.#state.jobs.find((item) => item.status === 'queued' || item.status === 'reporting');
    if (!job) return;
    if (job.status === 'queued') {
      try {
        await this.#update(job, 'progress', 'Link received the task.');
      } catch (error) {
        if (error.status !== 404 && error.status !== 409) throw error;
        job.status = 'done';
        delete job.prompt;
        await this.#save();
        return;
      }
      if (job.status === 'cancelled' || signal?.aborted) return;
      let approver = null;
      let approvals = null;
      try {
        const project = projectDirectory(this.#projects, job.projectId);
        const progressMessages = new Set();
        let sessionWrite = Promise.resolve();
        const notify = (event) => {
          if (event.session) {
            job.session = event.session;
            sessionWrite = this.#save();
            void sessionWrite.catch(() => this.#active?.process.cancel());
          }
          if (event.tools) {
            // The latest run's tool list is what this computer offers its employees now.
            this.#state.mcpTools = mcpToolsByServer(event.tools);
            void this.#save().catch(() => {});
          }
          if (event.progress && !progressMessages.has(event.progress)) {
            progressMessages.add(event.progress);
            void this.#update(job, 'progress', event.progress).catch(() => {});
          }
        };
        // Claude Code asks through Link's permission tool: the employee's mode decides, the room answers the rest.
        if (project.agent === 'claude-code') {
          approvals = new AbortController();
          approver = await this.#approver(job, await this.#policy(job), approvals.signal);
        }
        const process = project.agent === 'codex' && project.approvals === 'room'
          ? this.#launchWithApprovals(project, job.prompt, job.session, notify, (request, signal) => this.#approve(job, request, signal))
          : this.#launch(project, job.prompt, job.session, notify, approver);
        this.#active = { job, process };
        this.#onTask(true);
        void this.#api('/heartbeat', { busy: true, waitingAuthReason: null }, AbortSignal.timeout(10_000)).catch(() => {});
        void this.#update(job, 'progress', 'Agent started.').catch(() => {});
        job.outcome = await process.completed;
        await sessionWrite;
      } catch {
        if (this.#storageFailure) throw this.#storageFailure;
        job.outcome = { failure: 'Project directory or local agent is unavailable.' };
      } finally {
        approvals?.abort();
        approver?.close();
        if (this.#active) this.#onTask(false);
        this.#active = null;
      }
      if (job.status === 'cancelled' || job.outcome.cancelled) {
        await this.#api('/heartbeat', { busy: false }, AbortSignal.timeout(10_000));
        return;
      }
      job.status = 'reporting';
      await this.#save();
    }
    try {
      await this.#finish(job);
    } catch (error) {
      if (error.status !== 404 && error.status !== 409) throw error;
      job.status = 'done';
      delete job.prompt;
      delete job.outcome;
      await this.#save();
    }
    if (job.status === 'done') {
      await this.#api('/heartbeat', { busy: false }, AbortSignal.timeout(10_000));
    }
  }

  async start(externalSignal) {
    const shutdown = new AbortController();
    const signal = AbortSignal.any([externalSignal, shutdown.signal]);
    let retryMs = FIRST_POLL_RETRY_MS;
    let lastStatus;
    let publishAfter = 0;
    const markStatus = (status) => {
      if (status === lastStatus) return;
      lastStatus = status;
      this.#onStatus(status);
    };
    let work;
    const drain = async () => {
      while (!signal.aborted && this.#state.jobs.some((job) => job.status === 'queued' || job.status === 'reporting')) {
        await this.runNext(signal);
      }
    };
    const schedule = () => {
      work ??= drain().catch((error) => {
        if (this.#storageFailure) shutdown.abort();
        if (!signal.aborted) console.error(error.message);
      }).finally(() => { work = null; });
    };
    try {
      while (!signal.aborted) {
        schedule();
        try {
          if (Date.now() >= publishAfter) {
            await this.#api('/heartbeat', { capabilities: this.#capabilities() }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
            publishAfter = Date.now() + 30_000;
          }
          await this.poll(AbortSignal.any([signal, AbortSignal.timeout(28_000)]));
          markStatus('connected');
          retryMs = FIRST_POLL_RETRY_MS;
          schedule();
        } catch (error) {
          if (this.#storageFailure) throw this.#storageFailure;
          if (signal.aborted) break;
          if (error.status === 401) {
            markStatus('revoked');
            throw error;
          }
          markStatus('reconnecting');
          publishAfter = 0;
          console.error(error.message);
          await this.#sleep(retryMs, undefined, { signal }).catch(() => {});
          retryMs = Math.min(retryMs * 2, MAX_POLL_RETRY_MS);
        }
      }
    } finally {
      shutdown.abort();
      this.#active?.process.cancel();
      await work;
    }
    if (this.#storageFailure) throw this.#storageFailure;
  }
}
