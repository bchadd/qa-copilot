/**
 * Shared types used across reporter, CLI commands, and git utilities.
 */

/** A single AI-generated fix for a failed test, written to disk by the reporter */
export interface PendingFix {
  /** Unique ID for this fix within a session */
  id: string;
  /** Full test title path, e.g. "Login > should redirect after login" */
  testTitle: string;
  /** Absolute path to the test file */
  testFilePath: string;
  /** Original source of the test file at time of failure */
  originalSource: string;
  /** The Playwright error message */
  errorMessage: string;
  /** LLM diagnosis text */
  diagnosis: string;
  /** Human-readable explanation of the fix */
  explanation: string;
  /** Fixed file contents, or null if the LLM couldn't produce a structured fix */
  fixedCode: string | null;
  /** Full raw LLM response (for debugging/manual review) */
  rawLlmResponse: string;
  /** Whether the user has accepted, rejected, or not yet reviewed this fix */
  status: 'pending' | 'accepted' | 'rejected';
  /**
   * How this fix was generated:
   *   'auto'    — from a test failure caught by the reporter
   *   'inspect' — submitted manually via `qa-copilot inspect` with a screenshot
   */
  source: 'auto' | 'inspect';
  /** Visual context from the vision model, if a screenshot was analyzed */
  visualContext?: string;
  /** Absolute path(s) to screenshot(s) that informed this fix */
  screenshotPaths?: string[];
  createdAt: string;
}

/** qa-copilot config, read from .qa-copilot/config.json in the target project */
export interface CopilotConfig {
  ollamaUrl?: string;
  /** Code/reasoning model for diagnosis and fix generation */
  model?: string;
  /** Vision model for screenshot analysis (must be a multimodal model in Ollama) */
  visionModel?: string;
  /** Path to playwright config relative to project root, e.g. "playwright.config.ts" */
  playwrightConfig?: string;
}
