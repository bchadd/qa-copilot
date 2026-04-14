import { describe, it, expect } from 'vitest';
import {
  buildDiagnosisPrompt,
  buildFixPrompt,
  buildVisionAnalysisPrompt,
  buildCommitPrompt,
  buildInspectFixPrompt,
  parseFix,
} from '../../../src/ai/prompts';

// ---------------------------------------------------------------------------
// parseFix
// ---------------------------------------------------------------------------
describe('parseFix', () => {
  it('extracts explanation and code from a well-formed response', () => {
    const response = `
EXPLANATION:
Changed the selector from CSS to role-based locator.

FIXED_CODE:
\`\`\`typescript
import { test, expect } from '@playwright/test';
test('login', async ({ page }) => {
  await page.getByRole('button', { name: 'Submit' }).click();
});
\`\`\`
`.trim();

    const result = parseFix(response);
    expect(result).not.toBeNull();
    expect(result!.explanation).toBe('Changed the selector from CSS to role-based locator.');
    expect(result!.fixedCode).toContain("getByRole('button'");
  });

  it('returns null when EXPLANATION section is missing', () => {
    const response = `
FIXED_CODE:
\`\`\`typescript
const x = 1;
\`\`\`
`.trim();

    expect(parseFix(response)).toBeNull();
  });

  it('returns null when FIXED_CODE section is missing', () => {
    const response = `
EXPLANATION:
The selector was wrong.
`.trim();

    expect(parseFix(response)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseFix('')).toBeNull();
  });

  it('handles multiline explanations', () => {
    const response = `
EXPLANATION:
Line one of the explanation.
Line two of the explanation.

FIXED_CODE:
\`\`\`typescript
const x = 1;
\`\`\`
`.trim();

    const result = parseFix(response);
    expect(result).not.toBeNull();
    expect(result!.explanation).toContain('Line one');
    expect(result!.explanation).toContain('Line two');
  });

  it('accepts a fence with no language tag', () => {
    const response = `
EXPLANATION:
Fixed it.

FIXED_CODE:
\`\`\`
const x = 1;
\`\`\`
`.trim();

    const result = parseFix(response);
    expect(result).not.toBeNull();
    expect(result!.fixedCode).toBe('const x = 1;');
  });
});

// ---------------------------------------------------------------------------
// buildDiagnosisPrompt
// ---------------------------------------------------------------------------
describe('buildDiagnosisPrompt', () => {
  const base = {
    testTitle: 'Login > redirects after login',
    testFilePath: '/project/tests/login.spec.ts',
    testSourceCode: "test('redirects', async ({ page }) => { /* ... */ });",
    errorMessage: "Error: locator.click: element not found for '#submit'",
  };

  it('includes the test title', () => {
    const prompt = buildDiagnosisPrompt(base);
    expect(prompt).toContain('Login > redirects after login');
  });

  it('includes the test file path', () => {
    const prompt = buildDiagnosisPrompt(base);
    expect(prompt).toContain('/project/tests/login.spec.ts');
  });

  it('includes the test source code', () => {
    const prompt = buildDiagnosisPrompt(base);
    expect(prompt).toContain("test('redirects'");
  });

  it('includes the error message', () => {
    const prompt = buildDiagnosisPrompt(base);
    expect(prompt).toContain("element not found for '#submit'");
  });

  it('includes visual context when provided', () => {
    const prompt = buildDiagnosisPrompt({
      ...base,
      visualContext: 'The submit button is hidden behind a modal overlay.',
    });
    expect(prompt).toContain('submit button is hidden behind a modal overlay');
  });

  it('omits the visual context section when not provided', () => {
    const prompt = buildDiagnosisPrompt(base);
    expect(prompt).not.toContain('vision model');
  });

  it('includes related files section when relatedFiles is provided', () => {
    const prompt = buildDiagnosisPrompt({
      ...base,
      relatedFiles: { 'tests/fixtures/auth.ts': 'export const login = () => {};' },
    });
    expect(prompt).toContain('tests/fixtures/auth.ts');
    expect(prompt).toContain('export const login');
  });

  it('omits related files section when relatedFiles is empty', () => {
    const prompt = buildDiagnosisPrompt({ ...base, relatedFiles: {} });
    expect(prompt).not.toContain('Related file');
  });

  it('omits related files section when relatedFiles is undefined', () => {
    const prompt = buildDiagnosisPrompt(base);
    expect(prompt).not.toContain('Related file');
  });
});

// ---------------------------------------------------------------------------
// buildFixPrompt
// ---------------------------------------------------------------------------
describe('buildFixPrompt', () => {
  const base = {
    testTitle: 'Checkout > completes order',
    testFilePath: '/project/tests/checkout.spec.ts',
    testSourceCode: "test('completes order', async ({ page }) => {});",
    errorMessage: 'Timeout waiting for selector',
    diagnosis: 'The selector .pay-btn does not exist; the button uses a data-testid attribute.',
  };

  it('includes the diagnosis in the prompt', () => {
    const prompt = buildFixPrompt(base);
    expect(prompt).toContain('data-testid attribute');
  });

  it('includes the EXPLANATION / FIXED_CODE format instructions', () => {
    const prompt = buildFixPrompt(base);
    expect(prompt).toContain('EXPLANATION:');
    expect(prompt).toContain('FIXED_CODE:');
  });

  it('includes related files when provided', () => {
    const prompt = buildFixPrompt({
      ...base,
      relatedFiles: { 'tests/helpers/cart.ts': 'export const addToCart = () => {};' },
    });
    expect(prompt).toContain('tests/helpers/cart.ts');
  });
});

// ---------------------------------------------------------------------------
// buildVisionAnalysisPrompt
// ---------------------------------------------------------------------------
describe('buildVisionAnalysisPrompt', () => {
  it('returns a non-empty string', () => {
    expect(buildVisionAnalysisPrompt()).toBeTruthy();
  });

  it('includes user context when provided', () => {
    const prompt = buildVisionAnalysisPrompt('The modal is not closing after submission.');
    expect(prompt).toContain('modal is not closing after submission');
  });

  it('does not include an undefined/empty context line when omitted', () => {
    const prompt = buildVisionAnalysisPrompt();
    expect(prompt).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// buildCommitPrompt
// ---------------------------------------------------------------------------
describe('buildCommitPrompt', () => {
  it('includes the number of failures fixed', () => {
    const prompt = buildCommitPrompt({
      changedFiles: [{ path: 'tests/login.spec.ts', summary: 'Fixed selector' }],
      totalFailuresFixed: 3,
    });
    expect(prompt).toContain('3');
  });

  it('includes each changed file path', () => {
    const prompt = buildCommitPrompt({
      changedFiles: [
        { path: 'tests/login.spec.ts', summary: 'Fixed selector' },
        { path: 'tests/checkout.spec.ts', summary: 'Added wait' },
      ],
      totalFailuresFixed: 2,
    });
    expect(prompt).toContain('tests/login.spec.ts');
    expect(prompt).toContain('tests/checkout.spec.ts');
  });

  it('requests conventional commits format', () => {
    const prompt = buildCommitPrompt({
      changedFiles: [],
      totalFailuresFixed: 0,
    });
    expect(prompt).toContain('fix(tests)');
  });
});

// ---------------------------------------------------------------------------
// buildInspectFixPrompt
// ---------------------------------------------------------------------------
describe('buildInspectFixPrompt', () => {
  it('includes user context and visual description', () => {
    const prompt = buildInspectFixPrompt({
      userContext: 'Dropdown overlaps the submit button on mobile.',
      visualDescription: 'A dropdown menu extends beyond the viewport and covers a blue button.',
    });
    expect(prompt).toContain('Dropdown overlaps');
    expect(prompt).toContain('extends beyond the viewport');
  });

  it('instructs modification when an existing test file is provided', () => {
    const prompt = buildInspectFixPrompt({
      userContext: 'Button missing on mobile',
      visualDescription: 'The CTA button is not visible.',
      testFilePath: '/project/tests/mobile.spec.ts',
      testSourceCode: "test('cta visible', async ({ page }) => {});",
    });
    expect(prompt).toContain('/project/tests/mobile.spec.ts');
    expect(prompt).toContain("test('cta visible'");
    expect(prompt).toContain('Modify the existing test file');
  });

  it('instructs writing a new file when no test file is provided', () => {
    const prompt = buildInspectFixPrompt({
      userContext: 'Button missing on mobile',
      visualDescription: 'The CTA button is not visible.',
    });
    expect(prompt).toContain('new Playwright test file');
  });
});
