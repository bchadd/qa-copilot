/**
 * Discovers the target Playwright project and loads QA Copilot's own config.
 *
 * Search order for playwright.config.ts:
 *   1. QA_COPILOT_PW_CONFIG env var
 *   2. .qa-copilot/config.json `playwrightConfig` field
 *   3. playwright.config.ts in cwd
 *   4. playwright.config.js in cwd
 */

import fs from 'fs';
import path from 'path';
import type { CopilotConfig, PendingFix } from './types';

const COPILOT_DIR = '.qa-copilot';
const CONFIG_FILE = 'config.json';
const MANIFEST_FILE = 'pending-fixes.json';

export function findProjectRoot(startDir: string = process.cwd()): string {
  // Walk up looking for playwright.config.ts / playwright.config.js
  let dir = startDir;
  while (true) {
    const hasPwConfig =
      fs.existsSync(path.join(dir, 'playwright.config.ts')) ||
      fs.existsSync(path.join(dir, 'playwright.config.js'));
    const hasPackageJson = fs.existsSync(path.join(dir, 'package.json'));

    if (hasPwConfig) return dir;

    // Stop at fs root or if we find package.json without playwright config
    // (don't walk above the project boundary)
    const parent = path.dirname(dir);
    if (parent === dir || hasPackageJson) return startDir;
    dir = parent;
  }
}

export function loadCopilotConfig(projectRoot: string): CopilotConfig {
  const configPath = path.join(projectRoot, COPILOT_DIR, CONFIG_FILE);
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as CopilotConfig;
  } catch {
    return {};
  }
}

export function saveCopilotConfig(projectRoot: string, config: CopilotConfig): void {
  const dir = path.join(projectRoot, COPILOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, CONFIG_FILE),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

export function loadPendingFixes(projectRoot: string): PendingFix[] {
  const manifestPath = path.join(projectRoot, COPILOT_DIR, MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PendingFix[];
  } catch {
    return [];
  }
}

export function savePendingFixes(projectRoot: string, fixes: PendingFix[]): void {
  const dir = path.join(projectRoot, COPILOT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MANIFEST_FILE),
    JSON.stringify(fixes, null, 2),
    'utf-8',
  );
}

/** Resolve the path to playwright config for the --config flag */
export function resolvePlaywrightConfig(projectRoot: string, config: CopilotConfig): string | null {
  if (process.env['QA_COPILOT_PW_CONFIG']) return process.env['QA_COPILOT_PW_CONFIG'];
  if (config.playwrightConfig) return path.join(projectRoot, config.playwrightConfig);
  if (fs.existsSync(path.join(projectRoot, 'playwright.config.ts')))
    return path.join(projectRoot, 'playwright.config.ts');
  if (fs.existsSync(path.join(projectRoot, 'playwright.config.js')))
    return path.join(projectRoot, 'playwright.config.js');
  return null;
}
