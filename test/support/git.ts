import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

const author = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];

export function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, ...author, 'commit', '-m', message);
}

// A local bare repo standing in for the GitHub remote, with one commit on `main`.
export function createBareRemote(root: string): string {
  const remote = join(root, 'remote.git');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '--initial-branch=main');
  commitFile(seed, 'README.md', '# Target Repo\n', 'Initial commit');
  git(seed, 'push', remote, 'main');
  return remote;
}
