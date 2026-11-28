import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_FOLDER_ENV = 'T3O_DATA_DIR';

// The per-user data folder, outside the Orchestrator's clone:
// `%LOCALAPPDATA%/t3o` on Windows, `~/.local/share/t3o` elsewhere, or `T3O_DATA_DIR`.
export function resolveDataFolder(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env[DATA_FOLDER_ENV];
  if (override) return override;
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 't3o');
  return join(home, '.local', 'share', 't3o');
}
