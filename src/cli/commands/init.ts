/**
 * `qa-copilot init`
 *
 * One-time setup wizard for a Playwright project. Writes .qa-copilot/config.json
 * with the user's preferred models and playwright config path, and updates
 * .gitignore to exclude the pending-fixes manifest.
 *
 * Why this matters:
 *  - Locks in the model choices so subsequent `run` calls are deterministic
 *  - Catches missing models before the first real run (prints the pull command)
 *  - Keeps pending-fixes.json out of git (it contains full test source)
 *  - Useful for teams: one engineer runs init, commits config.json, others just run
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { ollamaAvailable, listModels } from '../../ai/ollama';
import {
  findProjectRoot,
  loadCopilotConfig,
  saveCopilotConfig,
  resolvePlaywrightConfig,
} from '../../utils/config';
import type { CopilotConfig } from '../../utils/types';

const DEFAULT_CODE_MODEL = 'qwen2.5-coder:14b';
const DEFAULT_VISION_MODEL = 'llava:7b';
const GITIGNORE_ENTRY = '.qa-copilot/pending-fixes.json';

export async function initCommand(): Promise<void> {
  const projectRoot = findProjectRoot();
  const existing = loadCopilotConfig(projectRoot);

  console.log(chalk.cyan.bold('\n  QA Copilot — Project Setup\n'));

  // ── Ollama check ──────────────────────────────────────────────────────────
  const spinner = ora('Connecting to Ollama...').start();
  const ollamaUrl = existing.ollamaUrl ?? 'http://localhost:11434';
  const available = await ollamaAvailable(ollamaUrl);

  if (!available) {
    spinner.fail(chalk.red('Ollama is not running.'));
    console.log(chalk.gray('\n  Start it with: ollama serve'));
    console.log(chalk.gray('  Then run `qa-copilot init` again.\n'));
    process.exit(1);
  }

  const installedModels = await listModels(ollamaUrl);
  spinner.succeed(`Ollama connected  (${installedModels.length} model(s) available)`);

  if (installedModels.length === 0) {
    console.log(chalk.yellow('\n  No models installed yet.'));
    console.log(chalk.gray(`  Recommended: ollama pull ${DEFAULT_CODE_MODEL}`));
    console.log(chalk.gray(`               ollama pull ${DEFAULT_VISION_MODEL}\n`));
  } else {
    console.log(chalk.gray('  Installed: ' + installedModels.join(', ')));
  }

  console.log('');

  // ── Model selection ───────────────────────────────────────────────────────
  const modelChoices = installedModels.length > 0
    ? installedModels.map((m) => ({ name: m, value: m }))
    : [{ name: DEFAULT_CODE_MODEL + ' (not installed)', value: DEFAULT_CODE_MODEL }];

  const visionModelChoices = installedModels.length > 0
    ? installedModels.map((m) => ({ name: m, value: m }))
    : [{ name: DEFAULT_VISION_MODEL + ' (not installed)', value: DEFAULT_VISION_MODEL }];

  const answers = await inquirer.prompt<{
    codeModel: string;
    visionModel: string;
    ollamaUrl: string;
  }>([
    {
      type: 'list',
      name: 'codeModel',
      message: 'Code model (diagnosis + fix generation):',
      choices: [
        ...modelChoices,
        new inquirer.Separator(),
        { name: 'Enter a model name manually', value: '__manual__' },
      ],
      default: existing.model ?? DEFAULT_CODE_MODEL,
    },
    {
      type: 'input',
      name: 'codeModel',
      message: 'Enter code model name:',
      default: existing.model ?? DEFAULT_CODE_MODEL,
      when: (ans) => ans.codeModel === '__manual__',
    },
    {
      type: 'list',
      name: 'visionModel',
      message: 'Vision model (screenshot analysis):',
      choices: [
        ...visionModelChoices,
        new inquirer.Separator(),
        { name: 'Enter a model name manually', value: '__manual__' },
        { name: 'Skip — disable screenshot analysis', value: '__skip__' },
      ],
      default: existing.visionModel ?? DEFAULT_VISION_MODEL,
    },
    {
      type: 'input',
      name: 'visionModel',
      message: 'Enter vision model name:',
      default: existing.visionModel ?? DEFAULT_VISION_MODEL,
      when: (ans) => ans.visionModel === '__manual__',
    },
    {
      type: 'input',
      name: 'ollamaUrl',
      message: 'Ollama URL:',
      default: existing.ollamaUrl ?? 'http://localhost:11434',
    },
  ]);

  // ── Playwright config detection ───────────────────────────────────────────
  const detectedPwConfig = resolvePlaywrightConfig(projectRoot, existing);
  const relativeDetected = detectedPwConfig
    ? path.relative(projectRoot, detectedPwConfig)
    : null;

  const { playwrightConfig } = await inquirer.prompt<{ playwrightConfig: string }>([
    {
      type: 'input',
      name: 'playwrightConfig',
      message: 'Path to playwright.config.ts (relative to project root):',
      default: existing.playwrightConfig ?? relativeDetected ?? 'playwright.config.ts',
    },
  ]);

  // ── Warn about missing models ─────────────────────────────────────────────
  const missingModels: string[] = [];
  const codeModelName = answers.codeModel;
  const visionModelName = answers.visionModel === '__skip__' ? undefined : answers.visionModel;

  if (!installedModels.some((m) => m.startsWith(codeModelName.split(':')[0]!))) {
    missingModels.push(codeModelName);
  }
  if (visionModelName && !installedModels.some((m) => m.startsWith(visionModelName.split(':')[0]!))) {
    missingModels.push(visionModelName);
  }

  if (missingModels.length > 0) {
    console.log(chalk.yellow('\n  The following models are not installed:'));
    for (const m of missingModels) {
      console.log(chalk.gray(`    ollama pull ${m}`));
    }
    console.log('');
  }

  // ── Write config ──────────────────────────────────────────────────────────
  const config: CopilotConfig = {
    ollamaUrl: answers.ollamaUrl,
    model: codeModelName,
    visionModel: visionModelName,
    playwrightConfig,
  };

  saveCopilotConfig(projectRoot, config);
  console.log(chalk.green('\n✓ Config written to .qa-copilot/config.json'));

  // ── Update .gitignore ─────────────────────────────────────────────────────
  updateGitignore(projectRoot);

  console.log(chalk.green('✓ Added pending-fixes.json to .gitignore\n'));
  console.log(chalk.bold('Setup complete. Run your tests with:'));
  console.log(chalk.white('  qa-copilot run\n'));
}

function updateGitignore(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  let contents = '';
  if (fs.existsSync(gitignorePath)) {
    contents = fs.readFileSync(gitignorePath, 'utf-8');
  }

  if (contents.includes(GITIGNORE_ENTRY)) return; // already present

  const entry = `\n# QA Copilot — do not commit test source snapshots\n${GITIGNORE_ENTRY}\n`;
  fs.writeFileSync(gitignorePath, contents + entry, 'utf-8');
}
