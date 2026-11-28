// The Claude Code adapter for the Run port: runs `claude -p` one-shot with
// streamed JSON and a schema-constrained final result (research/headless-agents).
// Only the pure helpers are unit-tested; the process shell is covered by the manual
// smoke test in docs/smoke-test-claude-code.md, so tests never spend quota.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentRunner, JsonSchema, RunEvent, RunMode, RunRequest, RunResult, Usage } from './agent-runner.ts';

export type ClaudeCodeRunnerOptions = {
  command?: string; // default `claude`; must be an executable, not a .cmd shim (no shell is used)
  baseEnv?: Record<string, string | undefined>; // default process.env, stripped by buildClaudeEnv
};

const STOP_GRACE_MS = 5_000;
const STDERR_TAIL = 4_000;

export class ClaudeCodeRunner implements AgentRunner {
  private readonly command: string;
  private readonly baseEnv: Record<string, string | undefined>;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.command = options.command ?? 'claude';
    this.baseEnv = options.baseEnv ?? process.env;
  }

  async *start(req: RunRequest): AsyncIterable<RunEvent> {
    const env = buildClaudeEnv(this.baseEnv, req.scratchDir);
    for (const dir of [env.TEMP, env.XDG_CACHE_HOME]) if (dir) await mkdir(dir, { recursive: true });

    const stop = AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]);
    stop.throwIfAborted();
    const child = spawn(this.command, buildClaudeArgs(req), {
      cwd: req.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    exited.catch(() => {}); // awaited below; don't let an early spawn error go unhandled

    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    // SIGINT ends the turn cleanly; SIGKILL if it hasn't gone after a grace period.
    const onStop = () => {
      child.kill('SIGINT');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), STOP_GRACE_MS).unref();
    };
    stop.addEventListener('abort', onStop, { once: true });
    child.stdin.on('error', () => {}); // a crash before stdin is read surfaces through `exited`
    child.stdin.end(req.instructions);

    const stream = new ClaudeStream(req.mode);
    try {
      for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        yield* stream.push(raw);
      }
      const code = await exited;
      stop.throwIfAborted();
      const result = stream.end();
      if (!result) {
        throw new Error(`claude exited with code ${String(code)} without a result${stderr ? `: ${stderr.trim()}` : ''}`);
      }
      yield { type: 'result', result };
    } finally {
      stop.removeEventListener('abort', onStop);
      if (child.exitCode === null && child.signalCode === null) onStop(); // the caller stopped reading
    }
  }
}

type Json = Record<string, unknown>;

const ADAPTER_FIELDS = ['kind', 'usage'];

// The engine passes the full RunResult schema; the Agent fills all of it but
// `kind` (fixed by the mode) and `usage` (read from the stream by the adapter).
export function agentResultSchema(resultSchema: JsonSchema): JsonSchema {
  const properties = Object.fromEntries(
    Object.entries((resultSchema.properties ?? {}) as Json).filter(([key]) => !ADAPTER_FIELDS.includes(key)),
  );
  const required = ((resultSchema.required ?? []) as string[]).filter((key) => !ADAPTER_FIELDS.includes(key));
  return { ...resultSchema, properties, required };
}

type ContentBlock = { type?: string; text?: string; name?: string; input?: Json };

// The one input field worth showing in live output for each common tool.
function toolDetail(input: Json = {}): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function parse(raw: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

const rateLimitStatus = { allowed: 'allowed', allowed_warning: 'near-limit', rejected: 'rejected' } as const;

function rateLimit(info: Json = {}): RunEvent[] {
  const status = rateLimitStatus[info.status as keyof typeof rateLimitStatus];
  if (!status) return [];
  const event: RunEvent = { type: 'rate-limit', agent: 'claude', status };
  if (typeof info.resetsAt === 'number') event.resetsAt = new Date(info.resetsAt * 1000).toISOString();
  if (typeof info.utilization === 'number') event.utilization = info.utilization;
  return [event];
}

// Anything that looks like a credential, plus GitHub's and SSH's login plumbing. The
// Run uses the user's Claude subscription login from its own config folder, never an API key.
const SECRET = /TOKEN|API_?KEY|SECRET|PASSW(OR)?D|CREDENTIAL|^GH_|^GITHUB_|^SSH_AUTH_SOCK$|ASKPASS|^GIT_CONFIG_/i;
// These override `--model` / `--effort`, so the Model Tier asked for would not be the one that ran.
const TIER_OVERRIDES = /^(CLAUDE_CODE_EFFORT_LEVEL|ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL|CLAUDE_CODE_SUBAGENT_MODEL)$/i;

export function buildClaudeEnv(base: Record<string, string | undefined>, scratchDir: string): Record<string, string> {
  const tmp = join(scratchDir, 'tmp');
  const cache = join(scratchDir, 'cache');
  const set: Record<string, string> = {
    // No saved Git login and no prompts: an empty credential.helper clears every configured helper.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o IdentityAgent=none',
    // TEMP and package caches live in the Ticket's private scratch folder.
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    XDG_CACHE_HOME: cache,
    npm_config_cache: join(cache, 'npm'),
    npm_config_store_dir: join(cache, 'pnpm'),
    YARN_CACHE_FOLDER: join(cache, 'yarn'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    GOCACHE: join(cache, 'go-build'),
    GOMODCACHE: join(cache, 'go-mod'),
    NUGET_PACKAGES: join(cache, 'nuget'),
  };
  // Windows env names are case-insensitive: drop `Temp` before setting `TEMP`.
  const replaced = new Set(Object.keys(set).map((key) => key.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || SECRET.test(key) || TIER_OVERRIDES.test(key) || replaced.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return { ...env, ...set };
}

// Only the Orchestrator pushes and talks to GitHub. `git * push *` catches `git -C dir push`.
const NEVER = ['Bash(git push)', 'Bash(git push *)', 'Bash(git * push)', 'Bash(git * push *)', 'Bash(gh)', 'Bash(gh *)'];
const READ_ONLY_GIT = ['diff', 'log', 'show', 'status'].flatMap((cmd) => [`Bash(git ${cmd})`, `Bash(git ${cmd} *)`]);

// Permission rules, passed with `--settings`. Deny rules win over allow rules from any source.
export function claudePermissions(mode: RunMode): { permissions: { allow: string[]; deny: string[] } } {
  if (mode === 'run') return { permissions: { allow: ['Bash'], deny: NEVER } };
  return { permissions: { allow: READ_ONLY_GIT, deny: ['Edit', 'Write', 'NotebookEdit', ...NEVER] } };
}

const HOUSE_RULES: Record<RunMode, string> = {
  run:
    'You are working one Ticket unattended for the T3 Orchestrator, in a git worktree on the Ticket branch. ' +
    'Commit your work on the current branch. Never push and never use gh: the Orchestrator pushes and opens the PR. ' +
    'Only write inside this worktree; use $TEMP for scratch files. Nobody will answer questions. ' +
    'If you cannot finish without a permission you lack, say so with status "needs-permission".',
  review:
    'You are reviewing a pull request unattended for the T3 Orchestrator. You are read-only: ' +
    'never edit files, commit or push. Nobody will answer questions.',
  plan:
    'You are the T3 Orchestrator Planner, reading the Target Repo. You are read-only: ' +
    'never edit files, commit or push.',
};

// The `claude` command line. The instructions go on stdin, which has no length limit.
export function buildClaudeArgs(req: Pick<RunRequest, 'tier' | 'mode' | 'resultSchema'>): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', req.tier.model,
    '--effort', req.tier.effort,
    // acceptEdits accepts edits inside the working directory only; anything else that
    // would prompt is denied because prompts are off. dontAsk denies all but reads and allow rules.
    '--permission-mode', req.mode === 'run' ? 'acceptEdits' : 'dontAsk',
    '--permission-prompts', 'none',
    '--settings', JSON.stringify(claudePermissions(req.mode)),
    '--json-schema', JSON.stringify(agentResultSchema(req.resultSchema)),
    '--append-system-prompt', HOUSE_RULES[req.mode],
  ];
}

// Claude reports cache writes and reads apart from fresh input; all of it is input.
function usageOf(msg: Json): Usage {
  const u = (msg.usage ?? {}) as Record<string, number | undefined>;
  const usage: Usage = {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
  if (typeof msg.total_cost_usd === 'number') usage.costUsd = msg.total_cost_usd;
  return usage;
}

function resultOf(mode: RunMode, msg: Json): RunResult {
  const usage = usageOf(msg);
  const structured = msg.structured_output as Json | undefined;
  if (mode === 'plan') throw new Error('plan results are not defined on the Run port yet');
  if (structured && typeof structured === 'object') {
    // The Agent fills everything but `kind` and `usage`, which only the adapter knows.
    return { ...structured, kind: mode, usage } as RunResult;
  }
  const text = typeof msg.result === 'string' && msg.result ? `: ${msg.result}` : '';
  const reason = `Claude Code ended without a structured result (${String(msg.subtype)})${text}`;
  if (mode === 'review') return { kind: 'review', verdict: 'unclear', findings: reason, door: 'unclear', usage };
  return { kind: 'run', status: 'failed', reason, prBody: '', door: 'unclear', blastRadius: '', usage };
}

// Reads `claude -p --output-format stream-json --verbose` output one line at a time.
export class ClaudeStream {
  private readonly mode: RunMode;
  private last: RunResult | undefined;

  constructor(mode: RunMode) {
    this.mode = mode;
  }

  push(raw: string): RunEvent[] {
    const msg = parse(raw);
    if (!msg) return [];
    if (msg.type === 'assistant') {
      const content = ((msg.message as Json | undefined)?.content ?? []) as ContentBlock[];
      return content.flatMap((block): RunEvent[] => {
        if (block.type === 'text' && block.text) return [{ type: 'text', text: block.text }];
        if (block.type === 'tool_use' && block.name) {
          return [{ type: 'tool', name: block.name, detail: toolDetail(block.input) }];
        }
        return [];
      });
    }
    if (msg.type === 'result') {
      // A task notification can follow a result and start another turn, so the last one wins.
      this.last = resultOf(this.mode, msg);
      return [];
    }
    if (msg.type === 'rate_limit_event') return rateLimit(msg.rate_limit_info as Json | undefined);
    return [];
  }

  // The Run's final result, once the process has exited; undefined if it never sent one.
  end(): RunResult | undefined {
    return this.last;
  }
}
