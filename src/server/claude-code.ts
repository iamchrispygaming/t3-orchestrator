// The Claude Code adapter for the Run port: runs `claude -p` one-shot with
// streamed JSON and a schema-constrained final result (research/headless-agents).
// Only the pure helpers are unit-tested; the process shell is covered by the manual
// smoke test in docs/smoke-test-claude-code.md, so tests never spend quota.
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { AgentRunner, JsonSchema, RunEvent, RunMode, RunRequest, RunResult, Usage } from './agent-runner.ts';

export type ClaudeCodeRunnerOptions = {
  command?: string; // default `claude`; must be an executable, not a .cmd shim (no shell is used)
  baseEnv?: Record<string, string | undefined>; // default process.env, stripped by buildClaudeEnv
};

const STOP_GRACE_MS = 5_000;

// The user's commit name and email, read with their real Git config before it is isolated away.
async function gitIdentity(cwd: string, env: Record<string, string | undefined>): Promise<GitIdentity | undefined> {
  const get = async (key: string) =>
    (await promisify(execFile)('git', ['config', '--get', key], { cwd, env }).catch(() => ({ stdout: '' }))).stdout.trim();
  const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
  return name && email ? { name, email } : undefined;
}
const STDERR_TAIL = 4_000;

export class ClaudeCodeRunner implements AgentRunner {
  private readonly command: string;
  private readonly baseEnv: Record<string, string | undefined>;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.command = options.command ?? 'claude';
    this.baseEnv = options.baseEnv ?? process.env;
  }

  async *start(req: RunRequest): AsyncIterable<RunEvent> {
    const env = buildClaudeEnv(this.baseEnv, req.scratchDir, await gitIdentity(req.cwd, this.baseEnv));
    for (const dir of [env.TEMP, env.XDG_CACHE_HOME]) if (dir) await mkdir(dir, { recursive: true });
    const gitConfig = isolatedGitConfig(req.scratchDir);
    await mkdir(dirname(gitConfig), { recursive: true });
    await writeFile(gitConfig, '');

    const stop = AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]);
    stop.throwIfAborted();
    const child = spawn(this.command, buildClaudeArgs(req), {
      cwd: req.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<ProcessExit>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
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
      const exit = await exited;
      stop.throwIfAborted();
      const result = stream.end(exit);
      if (!result) {
        const how = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${String(exit.code)}`;
        throw new Error(`claude ${how} without a result${stderr ? `: ${stderr.trim()}` : ''}`);
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

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

type ContentBlock ={ type?: string; text?: string; name?: string; input?: Json };

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
const SECRET = /TOKEN|API_?KEY|SECRET|PASSW(OR)?D|CREDENTIAL|^GH_|^GITHUB_|^SSH_AUTH_SOCK$|ASKPASS|^GIT_CONFIG|^GIT_SSH/i;

export type GitIdentity = { name: string; email: string };

// The empty Git config the Run sees in place of the user's global one; the runner creates it.
export const isolatedGitConfig = (scratchDir: string) => join(scratchDir, 'git', 'config');
// These override `--model` / `--effort`, so the Model Tier asked for would not be the one that ran.
const TIER_OVERRIDES = /^(CLAUDE_CODE_EFFORT_LEVEL|ANTHROPIC_MODEL|ANTHROPIC_DEFAULT_\w+_MODEL|CLAUDE_CODE_SUBAGENT_MODEL)$/i;

export function buildClaudeEnv(
  base: Record<string, string | undefined>,
  scratchDir: string,
  identity?: GitIdentity,
): Record<string, string> {
  const tmp = join(scratchDir, 'tmp');
  const cache = join(scratchDir, 'cache');
  const set: Record<string, string> = {
    // No saved Git login and no prompts. Askpass variables are set but empty so Git stops
    // looking instead of falling back to core.askPass or SSH_ASKPASS.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    // The user's global and system config (credential helpers, askPass, sshCommand) are not read.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: isolatedGitConfig(scratchDir),
    // Command-line scope beats the repo's own config: empty values clear helpers and askPass there too.
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.askPass',
    GIT_CONFIG_VALUE_1: '',
    // Programs a Run could plant in the repo's own config (`git config` needs no flag) that
    // would otherwise run under a read-only Review's `git status` / `git diff`.
    GIT_CONFIG_KEY_2: 'core.fsmonitor',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'core.pager',
    GIT_CONFIG_VALUE_3: 'cat',
    GIT_CONFIG_KEY_4: 'diff.external',
    GIT_CONFIG_VALUE_4: '',
    // No ssh config file, no agent and no identity files (naming one stops the defaults).
    GIT_SSH_COMMAND: 'ssh -F none -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=none -o IdentityAgent=none',
    GIT_SSH_VARIANT: 'ssh',
    // With the global config isolated away, commits still need the user's name and email.
    ...(identity && {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    }),
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
// The only shell commands a Review or the Planner may run. The fixed prefixes switch off
// external diff drivers and textconv filters, which run programs named in repo config.
const READ_ONLY_GIT_PREFIX = 'git --no-pager %s --no-ext-diff --no-textconv';
const READ_ONLY_GIT = [
  'Bash(git status)',
  'Bash(git status --short)',
  ...['diff', 'log', 'show'].map((cmd) => `Bash(${READ_ONLY_GIT_PREFIX.replace('%s', cmd)} *)`),
];
// Options and shell syntax that write a file even through an allowed prefix.
const READ_ONLY_DENY = ['Bash(*--output*)', 'Bash(*>*)', 'Bash(* --ext-diff*)', 'Bash(* --textconv*)'];

// Edits outside the worktree already need a prompt under acceptEdits, and prompts are off.
// These deny rules say it outright for the places that matter most. Edit rules match like
// .gitignore (a matching folder covers all inside it) and deny wins, so they name concrete
// home-folder places, and any that would contain the worktree are dropped.
const HOME_EDIT_DENY = [
  '.ssh/**',
  '.gitconfig',
  '.git-credentials',
  '.config/**',
  '.claude/**',
  '.claude.json',
  '.codex/**',
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  '.netrc',
  '.docker/**',
  '.aws/**',
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  'AppData/Roaming/**',
  'Documents/PowerShell/**',
];

// Shell writes outside the worktree that Bash rules can spot by their shape. A guard rail,
// not a sandbox: other programs (builds, installs, scripts) can still write anywhere.
const SHELL_WRITE_DENY = [
  'Bash(git config --global *)',
  'Bash(git config --system *)',
  'Bash(npm install -g *)',
  'Bash(npm i -g *)',
  'Bash(npm install --global *)',
  'Bash(npm i --global *)',
  'Bash(pnpm add -g *)',
  'Bash(yarn global *)',
  'Bash(pip install --user *)',
  ...['>', '>>'].flatMap((op) => [`Bash(*${op} ~*)`, `Bash(*${op}~*)`, `Bash(*${op} ../*)`, `Bash(*${op}../*)`]),
  ...['cp', 'mv'].flatMap((cmd) => [`Bash(${cmd} * ../*)`, `Bash(${cmd} * ~*)`, `Bash(${cmd} * /*)`]),
  ...['tee', 'tee -a'].flatMap((cmd) => [`Bash(${cmd} ../*)`, `Bash(${cmd} ~*)`, `Bash(${cmd} /*)`]),
  ...['rm', 'rm -r', 'rm -rf', 'rm -f'].flatMap((cmd) => [`Bash(${cmd} ../*)`, `Bash(${cmd} ~*)`, `Bash(${cmd} /*)`]),
  'Bash(rm * ../*)',
  'Bash(rm * ~*)',
  'Bash(rm * /*)',
];

const normalize = (path: string) => {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed; // Windows paths ignore case
};

function covers(home: string, pattern: string, cwd: string): boolean {
  const target = normalize(`${home}/${pattern.replace(/\/\*\*$/, '')}`);
  const dir = normalize(cwd);
  return dir === target || dir.startsWith(`${target}/`);
}

// Permission rules, passed with `--settings`. Deny rules win over allow rules from any source.
export function claudePermissions(
  mode: RunMode,
  cwd: string,
  home: string,
): { permissions: { allow: string[]; deny: string[] } } {
  if (mode === 'run') {
    const editDeny = HOME_EDIT_DENY.filter((pattern) => !covers(home, pattern, cwd)).map((p) => `Edit(~/${p})`);
    return { permissions: { allow: ['Bash'], deny: [...NEVER, ...SHELL_WRITE_DENY, ...editDeny] } };
  }
  return {
    permissions: { allow: READ_ONLY_GIT, deny: ['Edit', 'Write', 'NotebookEdit', ...NEVER, ...READ_ONLY_DENY] },
  };
}

const READ_ONLY_SHELL =
  'The only shell commands allowed are `git status`, `git status --short`, and ' +
  ['diff', 'log', 'show'].map((cmd) => `\`${READ_ONLY_GIT_PREFIX.replace('%s', cmd)} <args>\``).join(', ') +
  ', written exactly so, with no redirection and no --output.';

const HOUSE_RULES: Record<RunMode, string> = {
  run:
    'You are working one Ticket unattended for the T3 Orchestrator, in a git worktree on the Ticket branch. ' +
    'Commit your work on the current branch. Never push and never use gh: the Orchestrator pushes and opens the PR. ' +
    'Only write inside this worktree; use $TEMP for scratch files. Nobody will answer questions. ' +
    'If you cannot finish without a permission you lack, say so with status "needs-permission".',
  review:
    'You are reviewing a pull request unattended for the T3 Orchestrator. You are read-only: ' +
    'never edit files, commit or push. Nobody will answer questions. ' +
    READ_ONLY_SHELL,
  plan:
    'You are the T3 Orchestrator Planner, reading the Target Repo. You are read-only: ' +
    'never edit files, commit or push. ' +
    READ_ONLY_SHELL,
};

// The `claude` command line. The instructions go on stdin, which has no length limit.
export function buildClaudeArgs(
  req: Pick<RunRequest, 'tier' | 'mode' | 'resultSchema' | 'cwd'>,
  home: string = homedir(),
): string[] {
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
    '--settings', JSON.stringify(claudePermissions(req.mode, req.cwd, home)),
    '--json-schema', JSON.stringify(agentResultSchema(req.resultSchema)),
    '--append-system-prompt', HOUSE_RULES[req.mode],
    ...(req.mode === 'run'
      ? []
      : [
          // Read-only: no edit tools at all, and no user/project/local settings, hooks,
          // plugins or project MCP servers (a Run could have planted them in the worktree).
          '--tools', 'Read,Grep,Glob,Bash',
          '--setting-sources', '',
          '--strict-mcp-config',
        ]),
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
  // A non-zero exit or a kill overrides whatever the Agent reported (Spec story 43).
  end(exit: ProcessExit = { code: 0, signal: null }): RunResult | undefined {
    const result = this.last;
    if (!result || (exit.code === 0 && exit.signal === null)) return result;
    const how = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${String(exit.code)}`;
    // A Planner turn that ends badly has no partial answer worth keeping: report no result.
    if (result.kind === 'plan') return undefined;
    if (result.kind === 'review') {
      const findings = `claude ${how} after reporting ${result.verdict}.${result.findings ? ` ${result.findings}` : ''}`;
      return { ...result, verdict: 'unclear', findings, door: 'unclear' };
    }
    const reason = `claude ${how} after reporting ${result.status}${result.reason ? `. ${result.reason}` : ''}`;
    return { ...result, status: 'failed', reason, door: 'unclear' };
  }
}
