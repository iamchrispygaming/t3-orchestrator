// The Claude Code adapter's pure helpers, checked against handwritten
// stream-json samples. Nothing here runs `claude`; real runs are the manual
// smoke test in docs/smoke-test-claude-code.md.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { reviewOutcomeSchema, runOutcomeSchema } from '../src/server/agent-runner.ts';
import { join } from 'node:path';
import type { RunMode } from '../src/server/agent-runner.ts';
import { agentResultSchema, buildClaudeArgs, buildClaudeEnv, ClaudeStream } from '../src/server/claude-code.ts';

const line = (o: unknown) => JSON.stringify(o);

describe('ClaudeStream: streamed events become RunEvents', () => {
  it('turns assistant text into text events', () => {
    const stream = new ClaudeStream('run');
    const events = stream.push(
      line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the Ticket.' }] },
        parent_tool_use_id: null,
        session_id: 's1',
      }),
    );
    expect(events).toEqual([{ type: 'text', text: 'Reading the Ticket.' }]);
  });

  it('turns tool calls into tool events naming the tool and its target', () => {
    const stream = new ClaudeStream('run');
    const events = stream.push(
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' } },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: 'tool', name: 'Bash', detail: 'npm test' },
      { type: 'tool', name: 'Edit', detail: 'src/a.ts' },
    ]);
  });

  it('turns rate-limit events into rate-limit events for the quota port', () => {
    const stream = new ClaudeStream('run');
    // Shape from the Agent SDK's SDKRateLimitEvent (research/cost-and-quota); resetsAt is epoch seconds.
    expect(
      stream.push(
        line({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed_warning', resetsAt: 1795000000, utilization: 0.82, rateLimitType: 'five_hour' },
          session_id: 's1',
        }),
      ),
    ).toEqual([
      { type: 'rate-limit', agent: 'claude', status: 'near-limit', resetsAt: '2026-11-18T11:06:40.000Z', utilization: 0.82 },
    ]);
    expect(stream.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }))).toEqual([
      { type: 'rate-limit', agent: 'claude', status: 'rejected' },
    ]);
    expect(stream.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))).toEqual([
      { type: 'rate-limit', agent: 'claude', status: 'allowed' },
    ]);
  });

  it('ignores system, user and unparseable lines', () => {
    const stream = new ClaudeStream('run');
    expect(stream.push(line({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' }))).toEqual([]);
    expect(stream.push(line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }))).toEqual([]);
    expect(stream.push('not json at all')).toEqual([]);
    expect(stream.push('')).toEqual([]);
  });
});

const usage = { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 500, output_tokens: 450 };

const resultLine = (over: Record<string, unknown>) =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 7,
    session_id: 's1',
    result: 'All done.',
    usage,
    total_cost_usd: 0.42,
    permission_denials: [],
    ...over,
  });

describe('ClaudeStream: the final result becomes a RunResult', () => {
  it("maps a Run's structured output and usage", () => {
    const stream = new ClaudeStream('run');
    const structured = { status: 'done', reason: '', prBody: '## Summary', door: 'two-way', blastRadius: 'tests' };
    expect(stream.push(resultLine({ structured_output: structured }))).toEqual([]);
    expect(stream.end()).toEqual({
      kind: 'run',
      status: 'done',
      reason: '',
      prBody: '## Summary',
      door: 'two-way',
      blastRadius: 'tests',
      usage: { inputTokens: 2000, outputTokens: 450, costUsd: 0.42 },
    });
  });

  it("maps a Review's structured output", () => {
    const stream = new ClaudeStream('review');
    stream.push(resultLine({ structured_output: { verdict: 'changes-needed', findings: 'Missing test.', door: 'one-way' } }));
    expect(stream.end()).toEqual({
      kind: 'review',
      verdict: 'changes-needed',
      findings: 'Missing test.',
      door: 'one-way',
      usage: { inputTokens: 2000, outputTokens: 450, costUsd: 0.42 },
    });
  });

  it('treats a Run that ends without structured output as failed, keeping usage', () => {
    const stream = new ClaudeStream('run');
    stream.push(resultLine({ subtype: 'error_max_turns', is_error: true, result: '' }));
    expect(stream.end()).toEqual({
      kind: 'run',
      status: 'failed',
      reason: 'Claude Code ended without a structured result (error_max_turns)',
      prBody: '',
      door: 'unclear',
      blastRadius: '',
      usage: { inputTokens: 2000, outputTokens: 450, costUsd: 0.42 },
    });
  });

  it('treats a Review without structured output as an unclear verdict', () => {
    const stream = new ClaudeStream('review');
    stream.push(resultLine({ result: 'I think it is fine?' }));
    expect(stream.end()).toEqual({
      kind: 'review',
      verdict: 'unclear',
      findings: 'Claude Code ended without a structured result (success): I think it is fine?',
      door: 'unclear',
      usage: { inputTokens: 2000, outputTokens: 450, costUsd: 0.42 },
    });
  });

  it('keeps the last result when another turn follows the first', () => {
    const stream = new ClaudeStream('run');
    stream.push(resultLine({ structured_output: { status: 'failed', reason: 'tests red', prBody: '', door: 'unclear', blastRadius: '' } }));
    stream.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Background task finished.' }] } }));
    stream.push(resultLine({ structured_output: { status: 'done', reason: '', prBody: 'b', door: 'two-way', blastRadius: 'x' } }));
    expect(stream.end()).toMatchObject({ kind: 'run', status: 'done' });
  });

  it('has no result when the stream never sent one', () => {
    const stream = new ClaudeStream('run');
    stream.push(line({ type: 'system', subtype: 'init' }));
    expect(stream.end()).toBeUndefined();
  });
});

describe('agentResultSchema: what the Agent is asked to fill', () => {
  it('drops kind and usage, which only the adapter knows', () => {
    const schema = agentResultSchema(z.toJSONSchema(runOutcomeSchema) as Record<string, unknown>);
    expect(Object.keys(schema.properties as object)).toEqual(['status', 'reason', 'prBody', 'door', 'blastRadius']);
    expect(schema.required).toEqual(['status', 'reason', 'prBody', 'door', 'blastRadius']);
    expect(schema.type).toBe('object');
  });

  it('works for the Review schema too', () => {
    const schema = agentResultSchema(z.toJSONSchema(reviewOutcomeSchema) as Record<string, unknown>);
    expect(schema.required).toEqual(['verdict', 'findings', 'door']);
  });
});

describe('buildClaudeEnv: the environment a Run starts with', () => {
  const scratch = join('data', 'scratch', '41');
  const base = {
    Path: 'C:/bin',
    USERPROFILE: 'C:/Users/me',
    APPDATA: 'C:/Users/me/AppData/Roaming',
    LANG: 'en_US.UTF-8',
    GH_TOKEN: 'gho_x',
    GITHUB_TOKEN: 'ghp_x',
    GH_ENTERPRISE_TOKEN: 'x',
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_AUTH_TOKEN: 'x',
    OPENAI_API_KEY: 'sk-oa',
    CODEX_API_KEY: 'x',
    AWS_SECRET_ACCESS_KEY: 'x',
    npm_token: 'x',
    DB_PASSWORD: 'x',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    GIT_ASKPASS: 'askpass.exe',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: 'manager',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    ANTHROPIC_MODEL: 'opus',
    Temp: 'C:/Users/me/AppData/Local/Temp',
  };

  it('keeps ordinary variables and strips GitHub tokens, API keys and other secrets', () => {
    const env = buildClaudeEnv(base, scratch);
    expect(env).toMatchObject({ Path: 'C:/bin', USERPROFILE: 'C:/Users/me', LANG: 'en_US.UTF-8' });
    for (const name of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'npm_token',
      'DB_PASSWORD',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('strips variables that would override the Model Tier', () => {
    const env = buildClaudeEnv(base, scratch);
    expect(env).not.toHaveProperty('CLAUDE_CODE_EFFORT_LEVEL');
    expect(env).not.toHaveProperty('ANTHROPIC_MODEL');
  });

  it('gives Git no saved login and no prompts', () => {
    const env = buildClaudeEnv(base, scratch);
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      // An empty credential.helper clears every helper set in system, global or repo config.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o IdentityAgent=none',
    });
  });

  it("points TEMP and package caches at the Ticket's scratch folder, replacing any casing", () => {
    const env = buildClaudeEnv(base, scratch);
    expect(env).not.toHaveProperty('Temp');
    expect(env).toMatchObject({
      TEMP: join(scratch, 'tmp'),
      TMP: join(scratch, 'tmp'),
      TMPDIR: join(scratch, 'tmp'),
      XDG_CACHE_HOME: join(scratch, 'cache'),
      npm_config_cache: join(scratch, 'cache', 'npm'),
      npm_config_store_dir: join(scratch, 'cache', 'pnpm'),
      YARN_CACHE_FOLDER: join(scratch, 'cache', 'yarn'),
      PIP_CACHE_DIR: join(scratch, 'cache', 'pip'),
      GOCACHE: join(scratch, 'cache', 'go-build'),
      GOMODCACHE: join(scratch, 'cache', 'go-mod'),
      NUGET_PACKAGES: join(scratch, 'cache', 'nuget'),
    });
  });
});

describe('buildClaudeArgs: how claude -p is started', () => {
  const resultSchema = z.toJSONSchema(runOutcomeSchema) as Record<string, unknown>;
  const req = (mode: RunMode) => ({ tier: { agent: 'claude' as const, model: 'sonnet', effort: 'medium' }, mode, resultSchema });
  const flag = (args: string[], name: string) => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const permissions = (args: string[]) =>
    (JSON.parse(flag(args, '--settings') ?? '{}') as { permissions: { allow: string[]; deny: string[] } }).permissions;

  it('runs one-shot with streamed JSON at the Model Tier asked for', () => {
    const args = buildClaudeArgs(req('run'));
    expect(args[0]).toBe('-p');
    expect(flag(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(flag(args, '--model')).toBe('sonnet');
    expect(flag(args, '--effort')).toBe('medium');
  });

  it('constrains the final answer to the fields the Agent fills', () => {
    const args = buildClaudeArgs(req('run'));
    expect(JSON.parse(flag(args, '--json-schema') ?? '{}')).toMatchObject({
      required: ['status', 'reason', 'prBody', 'door', 'blastRadius'],
    });
  });

  it('never prompts, and uses the subscription login rather than --bare', () => {
    for (const mode of ['run', 'review', 'plan'] as const) {
      const args = buildClaudeArgs(req(mode));
      expect(flag(args, '--permission-prompts')).toBe('none');
      expect(args).not.toContain('--bare');
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(flag(args, '--permission-mode')).not.toBe('bypassPermissions');
    }
  });

  it('lets a Run edit its worktree and run commands, but never push or use gh', () => {
    const args = buildClaudeArgs(req('run'));
    // acceptEdits accepts edits inside the working directory only; anything outside would
    // prompt, and with prompts off it is denied.
    expect(flag(args, '--permission-mode')).toBe('acceptEdits');
    expect(args).not.toContain('--add-dir');
    const rules = permissions(args);
    expect(rules.allow).toContain('Bash');
    expect(rules.deny).toEqual(
      expect.arrayContaining(['Bash(git push)', 'Bash(git push *)', 'Bash(git * push *)', 'Bash(gh)', 'Bash(gh *)']),
    );
  });

  it('keeps Reviews and the Planner read-only', () => {
    for (const mode of ['review', 'plan'] as const) {
      const args = buildClaudeArgs(req(mode));
      expect(flag(args, '--permission-mode')).toBe('dontAsk');
      const rules = permissions(args);
      expect(rules.allow).not.toContain('Bash');
      expect(rules.allow).toContain('Bash(git diff *)');
      expect(rules.deny).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'Bash(git push *)', 'Bash(gh *)']));
    }
  });

  it('tells the Agent the house rules in its system prompt', () => {
    expect(flag(buildClaudeArgs(req('run')), '--append-system-prompt')).toMatch(/commit/i);
    expect(flag(buildClaudeArgs(req('review')), '--append-system-prompt')).toMatch(/read-only/i);
  });
});
