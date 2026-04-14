/**
 * `qa-copilot inspect`
 *
 * Lets a QA engineer submit a screenshot of a visual regression their test
 * suite isn't catching, along with a plain-language description of the problem.
 * The copilot analyzes the screenshot with a vision model, then uses the coder
 * model to suggest a new or modified test that would catch the failure.
 *
 * The generated fix is written to .qa-copilot/pending-fixes.json so `qa-copilot fix`
 * handles the review + apply flow uniformly — same UX as auto-detected failures.
 *
 * Flags:
 *   --screenshot <path>   Path to the screenshot file (PNG or JPEG)
 *   --context <text>      Plain-language description of what's wrong
 *   --test <path>         Test file to modify (optional — omit to suggest a new file)
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { streamPrompt, imageToBase64 } from '../../ai/ollama';
import {
  buildVisionAnalysisPrompt,
  buildInspectFixPrompt,
  parseFix,
} from '../../ai/prompts';
import {
  findProjectRoot,
  loadCopilotConfig,
  loadPendingFixes,
  savePendingFixes,
} from '../../utils/config';
import type { PendingFix } from '../../utils/types';

export interface InspectOptions {
  screenshot?: string;
  context?: string;
  test?: string;
}

export async function inspectCommand(opts: InspectOptions): Promise<void> {
  const projectRoot = findProjectRoot();
  const config = loadCopilotConfig(projectRoot);

  const ollamaUrl = process.env['QA_COPILOT_OLLAMA_URL'] ?? config.ollamaUrl ?? 'http://localhost:11434';
  const codeModel = process.env['QA_COPILOT_MODEL'] ?? config.model ?? 'qwen2.5-coder:14b';
  const visionModel = process.env['QA_COPILOT_VISION_MODEL'] ?? config.visionModel ?? 'llava:7b';

  console.log(chalk.cyan.bold('\n  QA Copilot — Visual Regression Inspector\n'));

  // ── Gather inputs (flags → interactive fallback) ───────────────────────────
  const answers = await inquirer.prompt<{
    screenshotPath: string;
    userContext: string;
    testPath: string;
  }>([
    {
      type: 'input',
      name: 'screenshotPath',
      message: 'Path to screenshot:',
      default: opts.screenshot,
      when: !opts.screenshot,
      validate: (v: string) => {
        const p = path.resolve(v);
        if (!fs.existsSync(p)) return `File not found: ${p}`;
        const ext = path.extname(p).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext))
          return 'File must be a PNG, JPEG, or WebP image';
        return true;
      },
    },
    {
      type: 'input',
      name: 'userContext',
      message: 'Describe what\'s visually wrong (plain language):',
      default: opts.context,
      when: !opts.context,
      validate: (v: string) => v.trim().length > 0 || 'Please describe the regression',
    },
    {
      type: 'input',
      name: 'testPath',
      message: 'Test file to modify (leave blank to suggest a new test):',
      default: opts.test ?? '',
      when: opts.test === undefined,
    },
  ]);

  const screenshotPath = path.resolve(opts.screenshot ?? answers.screenshotPath);
  const userContext = opts.context ?? answers.userContext;
  const rawTestPath = opts.test ?? answers.testPath;
  const testFilePath = rawTestPath || undefined;

  // Validate screenshot now if it was passed as a flag (skipped interactive validation)
  if (!fs.existsSync(screenshotPath)) {
    console.error(chalk.red(`Screenshot not found: ${screenshotPath}`));
    process.exit(1);
  }

  // Read test file if provided
  let testSourceCode: string | undefined;
  if (testFilePath) {
    const absTestPath = path.resolve(testFilePath);
    if (!fs.existsSync(absTestPath)) {
      console.error(chalk.red(`Test file not found: ${absTestPath}`));
      process.exit(1);
    }
    testSourceCode = fs.readFileSync(absTestPath, 'utf-8');
  }

  // ── Step 1: Vision analysis ───────────────────────────────────────────────
  console.log(chalk.bold('\nStep 1/2 — Analyzing screenshot with vision model...\n'));

  let visualDescription = '';
  try {
    const imageB64 = imageToBase64(screenshotPath);
    const visionSpinner = ora(`${visionModel} is reading the screenshot...`).start();

    await streamPrompt(
      buildVisionAnalysisPrompt(userContext),
      (token) => { process.stdout.write(token); visualDescription += token; },
      { baseUrl: ollamaUrl, model: visionModel, images: [imageB64], temperature: 0.3 },
      () => { visionSpinner.stop(); },
    );
    visualDescription = visualDescription.trim();
    console.log('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Vision analysis failed: ${msg}`));
    console.error(chalk.gray('Is your vision model installed? Try: ollama pull ' + visionModel));
    process.exit(1);
  }

  // ── Step 2: Fix generation ────────────────────────────────────────────────
  console.log(chalk.bold('Step 2/2 — Generating test suggestion...\n'));

  const fixSpinner = ora(`${codeModel} is generating a test suggestion...`).start();
  let fixResponse = '';
  try {
    await streamPrompt(
      buildInspectFixPrompt({
        userContext,
        visualDescription,
        testFilePath: testFilePath ? path.resolve(testFilePath) : undefined,
        testSourceCode,
      }),
      (token) => { process.stdout.write(token); fixResponse += token; },
      { baseUrl: ollamaUrl, model: codeModel },
      () => { fixSpinner.stop(); },
    );
    fixResponse = fixResponse.trim();
    console.log('\n');
  } catch (err) {
    fixSpinner.stop();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Fix generation failed: ${msg}`));
    process.exit(1);
  }

  const parsed = parseFix(fixResponse);

  if (!parsed) {
    console.log(chalk.yellow('Could not parse a structured fix. Raw response saved to manifest.\n'));
  }

  // ── Write to manifest ─────────────────────────────────────────────────────
  const existingFixes = loadPendingFixes(projectRoot);

  // Determine the target file path — if no existing test was given, we'll suggest
  // a new filename based on the context
  const targetFilePath = testFilePath
    ? path.resolve(testFilePath)
    : path.join(projectRoot, `tests/visual-regression-${Date.now()}.spec.ts`);

  const fix: PendingFix = {
    id: `inspect-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    testTitle: `[Inspect] ${userContext.slice(0, 80)}`,
    testFilePath: targetFilePath,
    originalSource: testSourceCode ?? '',
    errorMessage: `Visual regression: ${userContext}`,
    diagnosis: `Vision model observed: ${visualDescription}`,
    explanation: parsed?.explanation ?? '(see raw response)',
    fixedCode: parsed?.fixedCode ?? null,
    rawLlmResponse: fixResponse,
    status: 'pending',
    source: 'inspect',
    visualContext: visualDescription,
    screenshotPaths: [screenshotPath],
    createdAt: new Date().toISOString(),
  };

  existingFixes.push(fix);
  savePendingFixes(projectRoot, existingFixes);

  console.log(chalk.green('✓ Fix suggestion saved.'));
  console.log(chalk.gray('  Run `qa-copilot fix` to review and apply it.\n'));
}
