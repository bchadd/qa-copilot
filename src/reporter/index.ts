/**
 * QA Copilot — Custom Playwright Reporter
 *
 * Playwright loads this file in its own process via --reporter flag.
 * It intercepts each failed test in real time, reads the source file,
 * calls the LLM for diagnosis + fix, and writes a pending-fixes manifest
 * to disk so the CLI's `fix` command can pick it up.
 *
 * IPC between this reporter and the CLI process is intentionally simple:
 * a JSON file at .qa-copilot/pending-fixes.json in the project root.
 */

import type {
  Reporter,
  Suite,
  TestCase,
  TestResult,
  FullConfig,
} from '@playwright/test/reporter';
import fs from 'fs';
import path from 'path';
import ora from 'ora';
import { streamPrompt, imageToBase64 } from '../ai/ollama';
import {
  buildDiagnosisPrompt,
  buildFixPrompt,
  buildVisionAnalysisPrompt,
  parseFix,
} from '../ai/prompts';
import { resolveLocalImports } from '../utils/imports';
import type { PendingFix } from '../utils/types';

// Written per-run so the `fix` command knows what to show the user
const MANIFEST_FILENAME = 'pending-fixes.json';

class QACopilotReporter implements Reporter {
  private projectRoot: string = process.cwd();
  private ollamaBaseUrl: string = 'http://localhost:11434';
  private ollamaModel: string = 'qwen2.5-coder:14b';
  private ollamaVisionModel: string = 'llava:7b';
  private pendingFixes: PendingFix[] = [];
  private manifestDir: string = '';

  onBegin(config: FullConfig, _suite: Suite): void {
    this.projectRoot = config.rootDir;
    this.manifestDir = path.join(this.projectRoot, '.qa-copilot');

    // Allow env overrides so users can point at a different Ollama instance/model
    this.ollamaBaseUrl = process.env['QA_COPILOT_OLLAMA_URL'] ?? this.ollamaBaseUrl;
    this.ollamaModel = process.env['QA_COPILOT_MODEL'] ?? this.ollamaModel;
    this.ollamaVisionModel = process.env['QA_COPILOT_VISION_MODEL'] ?? this.ollamaVisionModel;

    // Reset fixes manifest for this run
    fs.mkdirSync(this.manifestDir, { recursive: true });
    this.pendingFixes = [];

    console.log('\n[QA Copilot] Reporter active — will diagnose failures with AI\n');
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    if (result.status === 'passed' || result.status === 'skipped') return;
    if (result.status === 'timedOut' && result.errors.length === 0) return;

    const testFilePath = test.location.file;
    const testTitle = test.titlePath().join(' > ');

    // Read the test file source so the LLM has full context
    let testSourceCode = '';
    try {
      testSourceCode = fs.readFileSync(testFilePath, 'utf-8');
    } catch {
      testSourceCode = '(could not read test file)';
    }

    const primaryError = result.errors[0];
    const errorMessage = primaryError?.message ?? 'Unknown error';
    const errorStack = primaryError?.stack;

    // Derive the page URL from the error stack/message if Playwright embeds it
    const pageUrl = this.extractPageUrl(errorMessage + (errorStack ?? ''));

    // Collect screenshot attachments Playwright captured during the test
    const screenshotPaths = result.attachments
      .filter((a) => a.name === 'screenshot' && a.path)
      .map((a) => a.path as string);

    // Resolve local imports (fixtures, helpers, page objects) for richer LLM context
    const relatedFiles = resolveLocalImports(testFilePath, this.projectRoot);

    console.log(`\n[QA Copilot] Analyzing failure: ${testTitle}`);
    console.log('─'.repeat(60));

    try {
      // Step 0 — Vision analysis (if screenshots are available)
      let visualContext: string | undefined;
      if (screenshotPaths.length > 0) {
        const visionSpinner = ora({
          text: `Analyzing screenshot (${this.ollamaVisionModel})...`,
          prefixText: '[QA Copilot]',
        }).start();
        try {
          const images = screenshotPaths.map(imageToBase64);
          let visionResponse = '';
          await streamPrompt(
            buildVisionAnalysisPrompt(),
            (token) => { process.stdout.write(token); visionResponse += token; },
            { baseUrl: this.ollamaBaseUrl, model: this.ollamaVisionModel, images, temperature: 0.3 },
            () => { visionSpinner.stop(); },
          );
          visualContext = visionResponse.trim();
          console.log('\n');
        } catch (visionErr) {
          visionSpinner.stop();
          const msg = visionErr instanceof Error ? visionErr.message : String(visionErr);
          console.log(`[QA Copilot] Vision analysis skipped: ${msg}\n`);
        }
      }

      // Step 1 — Diagnosis
      const diagnosisSpinner = ora({
        text: `Diagnosing (${this.ollamaModel})...`,
        prefixText: '[QA Copilot]',
      }).start();

      const diagnosisPrompt = buildDiagnosisPrompt({
        testTitle,
        testFilePath,
        testSourceCode,
        errorMessage,
        errorStack,
        pageUrl,
        visualContext,
        relatedFiles,
      });

      let diagnosis = '';
      await streamPrompt(
        diagnosisPrompt,
        (token) => { process.stdout.write(token); diagnosis += token; },
        { baseUrl: this.ollamaBaseUrl, model: this.ollamaModel },
        () => { diagnosisSpinner.stop(); },
      );
      diagnosis = diagnosis.trim();
      console.log('\n');

      // Step 2 — Fix generation
      const fixSpinner = ora({
        text: `Generating fix (${this.ollamaModel})...`,
        prefixText: '[QA Copilot]',
      }).start();

      const fixPrompt = buildFixPrompt({
        testTitle,
        testFilePath,
        testSourceCode,
        errorMessage,
        errorStack,
        pageUrl,
        visualContext,
        relatedFiles,
        diagnosis,
      });

      let fixResponse = '';
      await streamPrompt(
        fixPrompt,
        (token) => { process.stdout.write(token); fixResponse += token; },
        { baseUrl: this.ollamaBaseUrl, model: this.ollamaModel },
        () => { fixSpinner.stop(); },
      );
      fixResponse = fixResponse.trim();
      console.log('\n');

      const parsed = parseFix(fixResponse);

      if (!parsed) {
        console.log('[QA Copilot] Could not parse a structured fix from the LLM response.');
        console.log('[QA Copilot] Raw response saved to manifest for manual review.\n');
      }

      const fix: PendingFix = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        testTitle,
        testFilePath,
        originalSource: testSourceCode,
        errorMessage,
        diagnosis,
        explanation: parsed?.explanation ?? '(see raw response)',
        fixedCode: parsed?.fixedCode ?? null,
        rawLlmResponse: fixResponse,
        status: 'pending',
        source: 'auto',
        visualContext,
        screenshotPaths: screenshotPaths.length > 0 ? screenshotPaths : undefined,
        createdAt: new Date().toISOString(),
      };

      this.pendingFixes.push(fix);
      this.writeManifest();

      if (parsed) {
        console.log(`[QA Copilot] Fix ready — run \`qa-copilot fix\` to review and apply.\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`\n[QA Copilot] AI analysis failed: ${message}`);
      console.log('[QA Copilot] Is Ollama running? Try: ollama serve\n');
    }
  }

  onEnd(): void {
    if (this.pendingFixes.length > 0) {
      console.log('─'.repeat(60));
      console.log(`[QA Copilot] ${this.pendingFixes.length} fix(es) ready.`);
      console.log(`[QA Copilot] Run \`qa-copilot fix\` to review and apply them.\n`);
    }
  }

  // ---------------------------------------------------------------------------

  private writeManifest(): void {
    const manifestPath = path.join(this.manifestDir, MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, JSON.stringify(this.pendingFixes, null, 2), 'utf-8');
  }

  /** Playwright often embeds the URL in error messages like "waiting for 'https://...'" */
  private extractPageUrl(text: string): string | undefined {
    const match = text.match(/https?:\/\/[^\s'"]+/);
    return match?.[0];
  }
}

export default QACopilotReporter;
