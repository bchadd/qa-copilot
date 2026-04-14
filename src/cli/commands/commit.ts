/**
 * Commit message generation.
 *
 * Called after the user accepts fixes. Uses the LLM to write a conventional
 * commit message, then prints it with copy-ready formatting.
 * Does NOT run `git commit` itself — that stays in the user's hands.
 */

import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { prompt as ollamaPrompt } from '../../ai/ollama';
import { buildCommitPrompt } from '../../ai/prompts';
import { loadCopilotConfig } from '../../utils/config';
import type { PendingFix } from '../../utils/types';

export async function generateCommitMessage(
  acceptedFixes: PendingFix[],
  projectRoot: string,
): Promise<void> {
  const config = loadCopilotConfig(projectRoot);
  const ollamaUrl = process.env['QA_COPILOT_OLLAMA_URL'] ?? config.ollamaUrl ?? 'http://localhost:11434';
  const model = process.env['QA_COPILOT_MODEL'] ?? config.model ?? 'qwen2.5-coder:14b';

  const changedFiles = acceptedFixes.map((fix) => ({
    path: path.relative(projectRoot, fix.testFilePath),
    summary: fix.explanation,
  }));

  const spinner = ora('Generating commit message...').start();

  try {
    const commitMsg = await ollamaPrompt(
      buildCommitPrompt({
        changedFiles,
        totalFailuresFixed: acceptedFixes.length,
      }),
      { baseUrl: ollamaUrl, model },
    );

    spinner.succeed('Commit message ready\n');

    console.log(chalk.bold('─'.repeat(60)));
    console.log(chalk.cyan(commitMsg));
    console.log(chalk.bold('─'.repeat(60)));
    console.log('');
    console.log(chalk.gray('Stage your changes, then commit with:'));
    console.log(chalk.white(`  git add ${changedFiles.map((f) => f.path).join(' ')}`));
    console.log(chalk.white(`  git commit -m "<paste message above>"`));
    console.log('');
  } catch (err) {
    spinner.fail('Could not generate commit message');
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(msg));
  }
}
