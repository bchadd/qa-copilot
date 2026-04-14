#!/usr/bin/env node
/**
 * QA Copilot CLI entry point
 *
 * Commands:
 *   qa-copilot init                          One-time project setup wizard
 *   qa-copilot run [-- <playwright args>]   Run tests + AI diagnosis
 *   qa-copilot fix                           Review and apply pending fixes
 *   qa-copilot status                        Show pending fixes without reviewing
 *   qa-copilot inspect                       Submit a screenshot for visual regression analysis
 *   qa-copilot clear                         Reset the pending-fixes manifest
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { runCommand } from './commands/run';
import { fixCommand } from './commands/fix';
import { initCommand } from './commands/init';
import { inspectCommand } from './commands/inspect';
import { clearCommand } from './commands/clear';
import { findProjectRoot, loadPendingFixes } from '../utils/config';

const program = new Command();

program
  .name('qa-copilot')
  .description('AI-powered Playwright test copilot')
  .version('0.1.0');

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('One-time setup wizard — configure models and playwright config path')
  .action(async () => {
    await initCommand();
  });

// ── run ───────────────────────────────────────────────────────────────────────
program
  .command('run')
  .description('Run your Playwright tests with AI failure diagnosis')
  .allowUnknownOption(true) // everything after -- passes through to playwright
  .action(async (_opts, cmd: Command) => {
    // commander collects unknown args (playwright passthrough) in cmd.args
    const playwrightArgs: string[] = cmd.args;
    await runCommand(playwrightArgs);
  });

// ── fix ───────────────────────────────────────────────────────────────────────
program
  .command('fix')
  .description('Review AI-generated fixes and apply them to your test files')
  .action(async () => {
    await fixCommand();
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show pending fixes from the last run')
  .action(() => {
    const projectRoot = findProjectRoot();
    const fixes = loadPendingFixes(projectRoot);

    if (fixes.length === 0) {
      console.log(chalk.gray('\nNo fixes on record. Run `qa-copilot run` first.\n'));
      return;
    }

    console.log(chalk.cyan.bold('\n  QA Copilot — Fix Status\n'));

    for (const fix of fixes) {
      const statusColor =
        fix.status === 'accepted'
          ? chalk.green
          : fix.status === 'rejected'
          ? chalk.red
          : chalk.yellow;

      const statusLabel =
        fix.status === 'accepted'
          ? '✓ accepted'
          : fix.status === 'rejected'
          ? '✗ rejected'
          : '· pending';

      console.log(`  ${statusColor(statusLabel)}  ${chalk.bold(fix.testTitle)}`);
      console.log(
        `             ${chalk.gray(path.relative(projectRoot, fix.testFilePath))}`,
      );
    }

    const pending = fixes.filter((f) => f.status === 'pending').length;
    if (pending > 0) {
      console.log(chalk.gray(`\n  ${pending} pending — run \`qa-copilot fix\` to review.\n`));
    } else {
      console.log('');
    }
  });

// ── inspect ───────────────────────────────────────────────────────────────────
program
  .command('inspect')
  .description('Analyze a screenshot of a visual regression and suggest a test fix')
  .option('-s, --screenshot <path>', 'Path to screenshot file (PNG, JPEG, or WebP)')
  .option('-c, --context <text>', 'Plain-language description of what\'s visually wrong')
  .option('-t, --test <path>', 'Test file to modify (omit to suggest a new test file)')
  .action(async (opts: { screenshot?: string; context?: string; test?: string }) => {
    await inspectCommand(opts);
  });

// ── clear ─────────────────────────────────────────────────────────────────────
program
  .command('clear')
  .description('Reset the pending-fixes manifest for this project')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (opts: { force?: boolean }) => {
    await clearCommand(opts);
  });

program.parse(process.argv);
