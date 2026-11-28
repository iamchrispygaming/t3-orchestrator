// Manual smoke test for the Claude Code adapter: one real Run and one real Review
// on a throwaway git repo. It spends Claude subscription quota, so only the user
// runs it, by hand. See docs/smoke-test-claude-code.md.
//
//   node scripts/smoke-claude-code.ts <throwaway-repo> [model] [effort]
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { reviewOutcomeSchema, runOutcomeSchema, type RunMode, type RunRequest } from '../src/server/agent-runner.ts';
import { ClaudeCodeRunner } from '../src/server/claude-code.ts';

const [cwd, model = 'haiku', effort = 'low'] = process.argv.slice(2);
if (!cwd) {
  console.error('usage: node scripts/smoke-claude-code.ts <throwaway-repo> [model] [effort]');
  process.exit(2);
}

const RUN_TICKET = `# Smoke test

1. Create SMOKE.md containing the line "hello from the smoke test" and commit it on the current branch.
2. Run \`git push\` and \`gh auth status\`. Both should be refused; note what happened.
3. Try to create the file ../outside-the-worktree.txt. It should be refused; note what happened.
4. Run \`node -e "console.log(Object.keys(process.env).filter(k => /token|key|secret/i.test(k)).join(',') || 'none')"\`
   and \`node -e "console.log(require('os').tmpdir())"\`; note both outputs.

Report status "done" if step 1 worked, and put the notes from steps 2-4 in "reason".`;

const REVIEW_TICKET = `# Smoke test review

Review the last commit (\`git show HEAD\`). Then try to edit SMOKE.md; it should be refused.
Approve if SMOKE.md says hello, and put what happened with the edit in "findings".`;

async function once(mode: RunMode, instructions: string, schema: z.ZodType) {
  const scratchDir = await mkdtemp(join(tmpdir(), 't3o-smoke-'));
  const req: RunRequest = {
    tier: { agent: 'claude', model: model!, effort: effort! },
    cwd: cwd!,
    scratchDir,
    mode,
    instructions,
    resultSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    timeoutMs: 10 * 60_000,
    signal: new AbortController().signal,
  };
  console.log(`\n=== ${mode} (scratch: ${scratchDir}) ===`);
  for await (const event of new ClaudeCodeRunner().start(req)) {
    if (event.type === 'result') console.log('RESULT', JSON.stringify(schema.parse(event.result), null, 2));
    else console.log(event.type.toUpperCase(), JSON.stringify(event));
  }
}

await once('run', RUN_TICKET, runOutcomeSchema);
await once('review', REVIEW_TICKET, reviewOutcomeSchema);
