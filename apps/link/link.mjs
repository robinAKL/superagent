import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchAgent, launchCodexWithApprovals, projectDirectory } from './agent.mjs';

const IDLE_ERROR_DELAY_MS = 2_000;
const STATE_TEMP_SUFFIX = '.tmp';

export class WorkerLink {
  #active = null;
  #state;
  #projects;
  #api;
  #stateFile;
  #launch;
  #launchWithApprovals;

  constructor(config, token, { fetcher = fetch, launch = launchAgent, launchWithApprovals = launchCodexWithApprovals } = {}) {
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
    try { this.#state = JSON.parse(readFileSync(config.stateFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.#state = { cursor: 0, jobs: [] };
    }
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

  #save() {
    mkdirSync(dirname(this.#stateFile), { recursive: true });
    const temporary = this.#stateFile + STATE_TEMP_SUFFIX;
    writeFileSync(temporary, JSON.stringify(this.#state), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.#stateFile);
  }

  #update(job, kind, body) {
    return this.#api('/room-tasks/' + encodeURIComponent(job.id) + '/' + kind, { body }, AbortSignal.timeout(10_000));
  }

  async #approve(job, request, signal) {
    const summary = {
      command: 'Codex requests permission to run a command.',
      file_change: 'Codex requests permission to change files.',
      network_access: 'Codex requests permission to access the network.',
    }[request.kind];
    const { approval } = await this.#api('/approvals', {
      roomTaskId: job.id, tool: 'codex.' + request.kind, input: request, summary,
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

  #wake(event) {
    const { roomTaskId, projectId, prompt } = event.payload ?? {};
    if (typeof roomTaskId !== 'string' || !roomTaskId || typeof projectId !== 'string' || typeof prompt !== 'string'
      || !prompt.trim() || prompt.length > 32_000 || this.#state.jobs.some((job) => job.id === roomTaskId)) return;
    this.#state.jobs.push({ id: roomTaskId, projectId, prompt, status: 'queued' });
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
      this.#state.cursor = event.seq;
      this.#save();
    }
  }

  async #finish(job) {
    if (job.status === 'cancelled') return;
    const outcome = job.outcome;
    if (outcome.result) await this.#update(job, 'report', outcome.result);
    else if (outcome.authentication) {
      await this.#api('/heartbeat', { busy: false, waitingAuthReason: outcome.authentication }, AbortSignal.timeout(10_000));
      await this.#update(job, 'progress', outcome.authentication);
    } else await this.#update(job, 'progress', outcome.failure);
    if (job.status !== 'cancelled') {
      job.status = outcome.authentication ? 'waiting_auth' : 'done';
      if (job.status === 'done') delete job.prompt;
      delete job.outcome;
      this.#save();
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
        this.#save();
        return;
      }
      if (job.status === 'cancelled' || signal?.aborted) return;
      try {
        const project = projectDirectory(this.#projects, job.projectId);
        const progressMessages = new Set();
        const notify = (event) => {
          if (event.session) { job.session = event.session; this.#save(); }
          if (event.progress && !progressMessages.has(event.progress)) {
            progressMessages.add(event.progress);
            void this.#update(job, 'progress', event.progress).catch(() => {});
          }
        };
        const process = project.agent === 'codex' && project.approvals === 'room'
          ? this.#launchWithApprovals(project, job.prompt, job.session, notify, (request, signal) => this.#approve(job, request, signal))
          : this.#launch(project, job.prompt, job.session, notify);
        this.#active = { job, process };
        void this.#api('/heartbeat', { busy: true, waitingAuthReason: null }, AbortSignal.timeout(10_000)).catch(() => {});
        void this.#update(job, 'progress', 'Agent started.').catch(() => {});
        job.outcome = await process.completed;
      } catch {
        job.outcome = { failure: 'Project directory or local agent is unavailable.' };
      } finally {
        this.#active = null;
      }
      if (job.status === 'cancelled' || job.outcome.cancelled) {
        await this.#api('/heartbeat', { busy: false }, AbortSignal.timeout(10_000));
        return;
      }
      job.status = 'reporting';
      this.#save();
    }
    try {
      await this.#finish(job);
    } catch (error) {
      if (error.status !== 404 && error.status !== 409) throw error;
      job.status = 'done';
      delete job.prompt;
      delete job.outcome;
      this.#save();
    }
    if (job.status === 'done') {
      await this.#api('/heartbeat', { busy: false }, AbortSignal.timeout(10_000));
    }
  }

  async start(externalSignal) {
    const shutdown = new AbortController();
    const signal = AbortSignal.any([externalSignal, shutdown.signal]);
    let work;
    const drain = async () => {
      while (!signal.aborted && this.#state.jobs.some((job) => job.status === 'queued' || job.status === 'reporting')) {
        await this.runNext(signal);
      }
    };
    const schedule = () => {
      work ??= drain().catch((error) => {
        if (!signal.aborted) console.error(error.message);
      }).finally(() => { work = null; });
    };
    try {
      while (!signal.aborted) {
        schedule();
        try {
          await this.poll(AbortSignal.any([signal, AbortSignal.timeout(35_000)]));
          schedule();
        } catch (error) {
          if (signal.aborted) break;
          if (error.status === 401) throw error;
          console.error(error.message);
          await delay(IDLE_ERROR_DELAY_MS, undefined, { signal }).catch(() => {});
        }
      }
    } finally {
      shutdown.abort();
      this.#active?.process.cancel();
      await work;
    }
  }
}
