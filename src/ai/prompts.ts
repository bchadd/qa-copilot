/**
 * Prompt templates for QA Copilot.
 * All prompts are scoped to TypeScript + Playwright.
 *
 * Design principles:
 *  - Give the model enough context to reason about the failure (error, code, selectors)
 *  - Ask for structured output so we can parse suggested file edits reliably
 *  - Keep system context concise — qwen2.5-coder handles Playwright well without heavy prompting
 */

export interface DiagnoseInput {
  testTitle: string;
  testFilePath: string;
  testSourceCode: string;
  errorMessage: string;
  errorStack?: string;
  pageUrl?: string;
  /** Visual description produced by the vision model, if a screenshot was available */
  visualContext?: string;
  /**
   * Local imports resolved from the test file: { relativeFilePath → source }.
   * Fixtures, helpers, page objects, etc. — gives the model full context.
   */
  relatedFiles?: Record<string, string>;
}

export interface FixInput extends DiagnoseInput {
  diagnosis: string;
}

export interface CommitInput {
  changedFiles: Array<{ path: string; summary: string }>;
  totalFailuresFixed: number;
}

const SYSTEM_CONTEXT = `\
You are QA Copilot, an expert in Playwright end-to-end testing with TypeScript.
Your job is to analyze failing Playwright tests and produce clear, actionable output.

Rules:
- All code you produce must be valid TypeScript compatible with Playwright's @playwright/test API.
- Prefer Playwright's built-in auto-waiting over manual waits (page.waitForTimeout).
- Prefer role-based locators (getByRole, getByLabel, getByText) over CSS/XPath selectors when appropriate.
- Never change what a test is asserting — only fix HOW it reaches the assertion.
- Be concise. Skip preamble.
`;

// ---------------------------------------------------------------------------
// Diagnosis prompt — explain what went wrong
// ---------------------------------------------------------------------------
export function buildDiagnosisPrompt(input: DiagnoseInput): string {
  return `${SYSTEM_CONTEXT}

## Failing Test

**Title:** ${input.testTitle}
**File:** ${input.testFilePath}
**Page URL at failure:** ${input.pageUrl ?? 'unknown'}

### Test source
\`\`\`typescript
${input.testSourceCode}
\`\`\`
${formatRelatedFiles(input.relatedFiles)}
### Error
\`\`\`
${input.errorMessage}
${input.errorStack ? '\n' + input.errorStack : ''}
\`\`\`

## Task
Diagnose why this Playwright test is failing. In 3–5 sentences, explain:
1. The root cause of the failure
2. Which specific line or selector is the problem
3. What category of issue this is (e.g. flaky selector, missing wait, timing race, wrong assertion, broken logic)
${input.visualContext ? `\nNote: a vision model analyzed the failure screenshot and observed:\n${input.visualContext}\nFactor this visual context into your diagnosis where relevant.` : ''}
Do NOT suggest a fix yet — just the diagnosis.
`;
}

// ---------------------------------------------------------------------------
// Fix prompt — produce a concrete code patch
// ---------------------------------------------------------------------------
export function buildFixPrompt(input: FixInput): string {
  return `${SYSTEM_CONTEXT}

## Failing Test

**Title:** ${input.testTitle}
**File:** ${input.testFilePath}

### Test source
\`\`\`typescript
${input.testSourceCode}
\`\`\`
${formatRelatedFiles(input.relatedFiles)}
### Error
\`\`\`
${input.errorMessage}
\`\`\`

### Diagnosis
${input.diagnosis}

## Task
Produce a fixed version of the test file that resolves the diagnosed issue.

Respond in this EXACT format — nothing before or after:

EXPLANATION:
<one or two sentences describing what you changed and why>

FIXED_CODE:
\`\`\`typescript
<complete fixed file contents>
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Commit message prompt
// ---------------------------------------------------------------------------
export function buildCommitPrompt(input: CommitInput): string {
  const fileList = input.changedFiles
    .map((f) => `- ${f.path}: ${f.summary}`)
    .join('\n');

  return `${SYSTEM_CONTEXT}

## Context
A QA Copilot session fixed ${input.totalFailuresFixed} failing Playwright test(s).

Changed files:
${fileList}

## Task
Write a git commit message for these changes. Use the conventional commits format:
  fix(tests): <short summary under 72 chars>

  <optional body: what was broken and what was changed, 2–4 sentences max>

Output only the commit message text. No markdown fences, no preamble.
`;
}

// ---------------------------------------------------------------------------
// Vision model prompt — describe what's wrong in a screenshot
// ---------------------------------------------------------------------------

/**
 * Sent to the vision model (e.g. llava, qwen2.5vl) alongside the image bytes.
 * The response is then passed as `visualContext` to the coder model prompts.
 */
export function buildVisionAnalysisPrompt(userContext?: string): string {
  return `You are analyzing a screenshot from a web application under test.
${userContext ? `The engineer notes: "${userContext}"\n` : ''}
Describe what you see in the screenshot. Focus on:
- The visible UI state (what components are shown, their layout and content)
- Any visual errors, overlaps, missing elements, or unexpected states
- Any text content that looks wrong, truncated, or out of place
- The general page context (what page or flow this appears to be)

Be specific and concise. Your description will be used by a code model to write or fix a Playwright test.`;
}

// ---------------------------------------------------------------------------
// Inspect prompt — generate a test fix from visual regression context
// ---------------------------------------------------------------------------

export interface InspectInput {
  userContext: string;
  visualDescription: string;
  testFilePath?: string;
  testSourceCode?: string;
}

export function buildInspectFixPrompt(input: InspectInput): string {
  const hasExistingTest = input.testFilePath && input.testSourceCode;

  return `${SYSTEM_CONTEXT}

## Visual Regression Report

A QA engineer has identified a visual regression that the current test suite is not catching.

**Engineer's description:**
${input.userContext}

**Vision model's observation of the screenshot:**
${input.visualDescription}

${hasExistingTest ? `## Existing Test File to Modify

**File:** ${input.testFilePath}

\`\`\`typescript
${input.testSourceCode}
\`\`\`

## Task
Modify the existing test file to add a test case (or update an existing one) that would catch the described visual regression.` : `## Task
Write a new Playwright test file in TypeScript that tests for the described visual regression.
The test should use @playwright/test and follow standard Playwright conventions.`}

The test should:
- Assert the specific visual condition that was failing (layout, visibility, overlap, content, etc.)
- Use Playwright's visual assertion methods where appropriate (e.g. toHaveScreenshot, toBeVisible, toHaveCSS)
- Include a descriptive test title that names the regression

Respond in this EXACT format — nothing before or after:

EXPLANATION:
<one or two sentences describing what the new/modified test checks and why>

FIXED_CODE:
\`\`\`typescript
<complete file contents>
\`\`\`
`;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

export interface ParsedFix {
  explanation: string;
  fixedCode: string;
}

/**
 * Format related files (fixtures, helpers, page objects) for inclusion in prompts.
 * Returns an empty string when there are no related files, so callers can
 * interpolate it unconditionally.
 */
function formatRelatedFiles(relatedFiles?: Record<string, string>): string {
  if (!relatedFiles || Object.keys(relatedFiles).length === 0) return '';

  const sections = Object.entries(relatedFiles)
    .map(([filePath, source]) => `### Related file: ${filePath}\n\`\`\`typescript\n${source}\n\`\`\``)
    .join('\n\n');

  return `\n### Related files (fixtures / helpers / page objects)\n\n${sections}\n`;
}

/**
 * Extract the EXPLANATION and FIXED_CODE sections from the LLM's fix response.
 * Returns null if the response doesn't match the expected format.
 */
export function parseFix(llmResponse: string): ParsedFix | null {
  const explanationMatch = llmResponse.match(/EXPLANATION:\s*([\s\S]*?)(?=FIXED_CODE:)/);
  const codeMatch = llmResponse.match(/FIXED_CODE:\s*```(?:typescript)?\s*([\s\S]*?)```/);

  if (!explanationMatch || !codeMatch) return null;

  return {
    explanation: explanationMatch[1].trim(),
    fixedCode: codeMatch[1].trim(),
  };
}
