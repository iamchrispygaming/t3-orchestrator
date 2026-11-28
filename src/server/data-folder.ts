import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DATA_FOLDER_ENV = 'T3O_DATA_DIR';

// The per-user data folder, outside the Orchestrator's clone:
// `%LOCALAPPDATA%/t3o` on Windows, `~/.local/share/t3o` elsewhere, or `T3O_DATA_DIR`
// (made absolute, so git commands run from other folders still find it).
export function resolveDataFolder(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env[DATA_FOLDER_ENV];
  if (override) return resolve(override);
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 't3o');
  return join(home, '.local', 'share', 't3o');
}

// The layout inside the data folder:
//   t3o.db
//   repos/<owner>/<repo>/{git,work/<issue#>,scratch/<issue#>}   (see folderName)
//   logs/<run-id>.jsonl
export function repoFolder(dataFolder: string, owner: string, name: string): string {
  return join(dataFolder, 'repos', folderName(owner), folderName(name));
}

// Windows device names, reserved with any extension: `con`, `aux.js`, `com1.txt`.
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/;

// A folder name for one part of a GitHub owner/repo that every OS accepts. Lowercased,
// since GitHub ignores case and so do the default Windows and macOS filesystems. A
// device name gets a `%` in front, and trailing dots (Windows drops them) become `%2e`.
// GitHub names never hold `%`, so two different repos never share a folder.
export function folderName(part: string): string {
  let folder = part.toLowerCase();
  const dots = /\.+$/.exec(folder)?.[0].length ?? 0;
  folder = folder.slice(0, folder.length - dots) + '%2e'.repeat(dots);
  return DEVICE_NAME.test(folder) ? `%${folder}` : folder;
}

export function runLogPath(dataFolder: string, runId: number): string {
  return join(dataFolder, 'logs', `${runId}.jsonl`);
}

export async function deleteRunLogs(dataFolder: string, runIds: number[]): Promise<void> {
  for (const runId of runIds) await rm(runLogPath(dataFolder, runId), { force: true });
}
