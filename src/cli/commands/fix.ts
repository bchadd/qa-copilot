/**
 * `qa-copilot fix`
 *
 * Loads the pending-fixes manifest written by the reporter, walks the user
 * through each fix with a diff preview, and applies accepted fixes.
 *
 * After review, prints a summary and offers to generate a commit message.
 */

import fs from 'fs';
import path from 'path';
import { createPatch } from 'diff';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { findProjectRoot, loadPendingFixes, savePendingFixes } from '../../utils/config';
import { generateCommitMessage } from '../commands/commit';
import type { PendingFix } from '../../utils/types';

function renderDiff(originalPath: string, original: string, fixed: string): void {
  const relativePath = path.relative(process.cwd(), originalPath);
  const patch = createPatch(relativePath, original, fixed, 'original', 'fixed');

  patch.split('\n').forEach((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      process.stdout.write(chalk.bold(line) + '\n');
    } else if (line.startsWith('+')) {
      process.stdout.write(chalk.green(line) + '\n');
    } else if (line.startsWith('-')) {
      process.stdout.write(chalk.red(line) + '\n');
    } else if (line.startsWith('@@')) {
      process.stdout.write(chalk.cyan(line) + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  });
}

export async function fixCommand(): Promise<void> {
  const projectRoot = findProjectRoot();
  const fixes = loadPendingFixes(projectRoot);

  if (fixes.length === 0) {
    console.log(chalk.gray('\nNo pending fixes. Run `qa-copilot run` first.\n'));
    return;
  }

  const pending = fixes.filter((f) => f.status === 'pending');
  if (pending.length === 0) {
    console.log(chalk.gray('\nAll fixes have already been reviewed.\n'));
    return;
  }

  console.log(chalk.cyan.bold(`\n  QA Copilot — Fix Review\n`));
  console.log(chalk.gray(`  ${pending.length} fix(es) to review\n`));

  const accepted: PendingFix[] = [];
  const rejected: PendingFix[] = [];

  for (let i = 0; i < pending.length; i++) {
    const fix = pending[i]!;

    console.log('═'.repeat(60));
    console.log(chalk.bold(`\nFix ${i + 1} of ${pending.length}`));
    console.log(chalk.yellow(`Test: `) + fix.testTitle);
    console.log(chalk.yellow(`File: `) + path.relative(projectRoot, fix.testFilePath));
    console.log(chalk.yellow(`Error: `) + chalk.red(fix.errorMessage.split('\n')[0]));
    console.log('');
    console.log(chalk.bold('Diagnosis:'));
    console.log(chalk.gray(fix.diagnosis));
    console.log('');

    if (!fix.fixedCode) {
      console.log(chalk.red('✗ No structured fix was generated for this failure.'));
      console.log(chalk.gray('  Raw LLM response:'));
      console.log(chalk.gray(fix.rawLlmResponse));
      console.log('');
      fix.status = 'rejected';
      rejected.push(fix);
      continue;
    }

    console.log(chalk.bold('Proposed fix:'));
    console.log(chalk.gray(`  ${fix.explanation}`));
    console.log('');
    console.log(chalk.bold('Diff:'));
    renderDiff(fix.testFilePath, fix.originalSource, fix.fixedCode);
    console.log('');

    const { decision } = await inquirer.prompt<{ decision: string }>([
      {
        type: 'list',
        name: 'decision',
        message: 'Apply this fix?',
        choices: [
          { name: 'Yes — apply the fix', value: 'accept' },
          { name: 'No — skip this fix', value: 'reject' },
          { name: 'Quit review', value: 'quit' },
        ],
      },
    ]);

    if (decision === 'quit') {
      console.log(chalk.gray('\nReview paused. Pending fixes saved.\n'));
      savePendingFixes(projectRoot, fixes);
      return;
    }

    if (decision === 'accept') {
      try {
        // Ensure parent directory exists (important for inspect-sourced new files)
        fs.mkdirSync(path.dirname(fix.testFilePath), { recursive: true });
        fs.writeFileSync(fix.testFilePath, fix.fixedCode, 'utf-8');
        fix.status = 'accepted';
        accepted.push(fix);
        console.log(chalk.green(`✓ Fix applied to ${path.relative(projectRoot, fix.testFilePath)}\n`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.red(`✗ Failed to write file: ${msg}\n`));
        fix.status = 'pending';
      }
    } else {
      fix.status = 'rejected';
      rejected.push(fix);
      console.log(chalk.gray('  Fix skipped.\n'));
    }
  }

  savePendingFixes(projectRoot, fixes);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('═'.repeat(60));
  console.log(chalk.bold('\nSummary\n'));
  console.log(`  ${chalk.green(`✓ ${accepted.length} applied`)}`);
  console.log(`  ${chalk.red(`✗ ${rejected.length} skipped`)}`);
  console.log('');

  if (accepted.length === 0) return;

  // ── Offer commit message ───────────────────────────────────────────────────
  const { wantCommitMsg } = await inquirer.prompt<{ wantCommitMsg: boolean }>([
    {
      type: 'confirm',
      name: 'wantCommitMsg',
      message: 'Generate a commit message for the applied fixes?',
      default: true,
    },
  ]);

  if (wantCommitMsg) {
    await generateCommitMessage(accepted, projectRoot);
  }
}
