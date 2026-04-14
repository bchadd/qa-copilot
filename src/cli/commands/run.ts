/**
 * `qa-copilot run [-- <playwright args>]`
 *
 * Wraps `npx playwright test`, injecting the QA Copilot reporter transparently.
 * All arguments after `--` are forwarded to Playwright verbatim.
 *
 * Example:
 *   qa-copilot run                        → runs all tests
 *   qa-copilot run -- --headed            → runs headed
 *   qa-copilot run -- tests/login.spec.ts → runs one file
 */

import { spawn } from 'child_process';
import path from 'path';
import chalk from 'chalk';
import { ollamaAvailable, listModels } from '../../ai/ollama';
import { findProjectRoot, loadCopilotConfig, resolvePlaywrightConfig } from '../../utils/config';

// The compiled reporter lives at dist/reporter/index.js relative to this package
function resolveReporterPath(): string {
  // __dirname will be dist/cli/commands at runtime
  return path.resolve(__dirname, '../../reporter/index.js');
}

export async function runCommand(playwrightArgs: string[]): Promise<void> {
  const projectRoot = findProjectRoot();
  const config = loadCopilotConfig(projectRoot);

  const ollamaUrl = process.env['QA_COPILOT_OLLAMA_URL'] ?? config.ollamaUrl ?? 'http://localhost:11434';
  const model = process.env['QA_COPILOT_MODEL'] ?? config.model ?? 'qwen2.5-coder:14b';
  const visionModel = process.env['QA_COPILOT_VISION_MODEL'] ?? config.visionModel ?? 'llava:7b';

  // ── Pre-flight checks ──────────────────────────────────────────────────────

  console.log(chalk.cyan.bold('\n  QA Copilot\n'));

  const available = await ollamaAvailable(ollamaUrl);
  if (!available) {
    console.error(chalk.red('✗ Ollama is not running.'));
    console.error(chalk.gray('  Start it with: ollama serve'));
    process.exit(1);
  }

  const models = await listModels(ollamaUrl);
  const hasModel = models.some((m) => m.startsWith(model.split(':')[0]!));
  if (!hasModel) {
    console.warn(chalk.yellow(`⚠ Model "${model}" not found in Ollama.`));
    console.warn(chalk.gray(`  Pull it with: ollama pull ${model}`));
    console.warn(chalk.gray('  Available models: ' + (models.join(', ') || 'none')));
    console.warn(chalk.gray('  Continuing anyway — Ollama may still serve the model.\n'));
  } else {
    console.log(chalk.green(`✓ Ollama running  (model: ${model})`));
  }

  const pwConfig = resolvePlaywrightConfig(projectRoot, config);
  if (pwConfig) {
    console.log(chalk.green(`✓ Playwright config found`));
    console.log(chalk.gray(`  ${path.relative(projectRoot, pwConfig)}`));
  } else {
    console.warn(chalk.yellow('⚠ No playwright.config.ts found in this directory.'));
  }

  const reporterPath = resolveReporterPath();
  console.log(chalk.gray(`  Reporter: ${reporterPath}\n`));

  // ── Build playwright command ───────────────────────────────────────────────

  const args: string[] = ['playwright', 'test'];

  if (pwConfig) {
    args.push('--config', pwConfig);
  }

  // Inject our reporter. If the user's playwright.config already defines reporters,
  // Playwright will merge them — our reporter is additive.
  args.push(`--reporter=${reporterPath}`);

  args.push(...playwrightArgs);

  // Propagate settings to the reporter subprocess via env
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QA_COPILOT_OLLAMA_URL: ollamaUrl,
    QA_COPILOT_MODEL: model,
    QA_COPILOT_VISION_MODEL: visionModel,
  };

  console.log(chalk.gray(`Running: npx ${args.join(' ')}\n`));
  console.log('─'.repeat(60) + '\n');

  const child = spawn('npx', args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env,
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
