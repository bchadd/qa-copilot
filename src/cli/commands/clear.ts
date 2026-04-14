/**
 * `qa-copilot clear`
 *
 * Resets the pending-fixes manifest for the current project.
 * Useful when switching between projects or starting a fresh session
 * without wanting stale fixes from a previous run to appear in `status`.
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { findProjectRoot, loadPendingFixes, savePendingFixes } from '../../utils/config';

export async function clearCommand(opts: { force?: boolean }): Promise<void> {
  const projectRoot = findProjectRoot();
  const fixes = loadPendingFixes(projectRoot);

  if (fixes.length === 0) {
    console.log(chalk.gray('\nNothing to clear — no fixes on record.\n'));
    return;
  }

  const pending = fixes.filter((f) => f.status === 'pending').length;
  const accepted = fixes.filter((f) => f.status === 'accepted').length;
  const rejected = fixes.filter((f) => f.status === 'rejected').length;

  console.log(chalk.cyan.bold('\n  QA Copilot — Clear Fixes\n'));
  console.log(`  ${fixes.length} fix(es) on record:`);
  if (pending)  console.log(chalk.yellow(`    · ${pending} pending`));
  if (accepted) console.log(chalk.green(`    ✓ ${accepted} accepted`));
  if (rejected) console.log(chalk.red(`    ✗ ${rejected} rejected`));
  console.log('');

  if (!opts.force) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Clear all fixes from the manifest?',
        default: false,
      },
    ]);

    if (!confirmed) {
      console.log(chalk.gray('\nAborted — nothing was changed.\n'));
      return;
    }
  }

  savePendingFixes(projectRoot, []);

  // Also remove the manifest file entirely for a clean state
  const manifestPath = path.join(projectRoot, '.qa-copilot', 'pending-fixes.json');
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }

  console.log(chalk.green('\n✓ Fix manifest cleared.\n'));
}
