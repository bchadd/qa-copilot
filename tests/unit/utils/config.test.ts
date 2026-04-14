import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findProjectRoot,
  loadCopilotConfig,
  saveCopilotConfig,
  loadPendingFixes,
  savePendingFixes,
  resolvePlaywrightConfig,
} from '../../../src/utils/config';
import type { PendingFix } from '../../../src/utils/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-copilot-config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePendingFix(overrides: Partial<PendingFix> = {}): PendingFix {
  return {
    id: 'test-id',
    testTitle: 'Sample test',
    testFilePath: '/project/tests/sample.spec.ts',
    originalSource: 'test code',
    errorMessage: 'something failed',
    diagnosis: 'the selector was wrong',
    explanation: 'switched to role locator',
    fixedCode: 'fixed code',
    rawLlmResponse: 'raw response',
    status: 'pending',
    source: 'auto',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findProjectRoot
// ---------------------------------------------------------------------------

describe('findProjectRoot', () => {
  it('returns the given dir when playwright.config.ts exists there', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '');
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it('returns the given dir when playwright.config.js exists there', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.js'), '');
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it('walks up to find playwright.config.ts in a parent directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '');
    const subDir = path.join(tmpDir, 'packages', 'app');
    fs.mkdirSync(subDir, { recursive: true });

    expect(findProjectRoot(subDir)).toBe(tmpDir);
  });

  it('falls back to the start dir when no playwright config is found', () => {
    // No playwright config, but there IS a package.json (stops the walk)
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// loadCopilotConfig / saveCopilotConfig
// ---------------------------------------------------------------------------

describe('loadCopilotConfig', () => {
  it('returns an empty object when no config file exists', () => {
    expect(loadCopilotConfig(tmpDir)).toEqual({});
  });

  it('returns an empty object when the config file contains invalid JSON', () => {
    const configDir = path.join(tmpDir, '.qa-copilot');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'config.json'), 'not-json');
    expect(loadCopilotConfig(tmpDir)).toEqual({});
  });

  it('returns the parsed config when the file is valid', () => {
    saveCopilotConfig(tmpDir, { model: 'qwen2.5-coder:14b', ollamaUrl: 'http://localhost:11434' });
    const config = loadCopilotConfig(tmpDir);
    expect(config.model).toBe('qwen2.5-coder:14b');
    expect(config.ollamaUrl).toBe('http://localhost:11434');
  });
});

describe('saveCopilotConfig', () => {
  it('creates the .qa-copilot directory if it does not exist', () => {
    saveCopilotConfig(tmpDir, { model: 'llava:7b' });
    expect(fs.existsSync(path.join(tmpDir, '.qa-copilot', 'config.json'))).toBe(true);
  });

  it('round-trips all config fields correctly', () => {
    const config = {
      ollamaUrl: 'http://custom:11434',
      model: 'qwen2.5-coder:14b',
      visionModel: 'llava:7b',
      playwrightConfig: 'e2e/playwright.config.ts',
    };
    saveCopilotConfig(tmpDir, config);
    expect(loadCopilotConfig(tmpDir)).toEqual(config);
  });
});

// ---------------------------------------------------------------------------
// loadPendingFixes / savePendingFixes
// ---------------------------------------------------------------------------

describe('loadPendingFixes', () => {
  it('returns an empty array when no manifest exists', () => {
    expect(loadPendingFixes(tmpDir)).toEqual([]);
  });

  it('returns an empty array when the manifest contains invalid JSON', () => {
    const dir = path.join(tmpDir, '.qa-copilot');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'pending-fixes.json'), 'not-json');
    expect(loadPendingFixes(tmpDir)).toEqual([]);
  });

  it('returns the parsed fixes when the manifest is valid', () => {
    const fix = makePendingFix();
    savePendingFixes(tmpDir, [fix]);
    const loaded = loadPendingFixes(tmpDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('test-id');
  });
});

describe('savePendingFixes', () => {
  it('round-trips multiple fixes correctly', () => {
    const fixes = [
      makePendingFix({ id: 'fix-1', status: 'pending' }),
      makePendingFix({ id: 'fix-2', status: 'accepted' }),
    ];
    savePendingFixes(tmpDir, fixes);
    const loaded = loadPendingFixes(tmpDir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.id).toBe('fix-1');
    expect(loaded[1]!.status).toBe('accepted');
  });

  it('overwrites the previous manifest on successive saves', () => {
    savePendingFixes(tmpDir, [makePendingFix({ id: 'old' })]);
    savePendingFixes(tmpDir, [makePendingFix({ id: 'new' })]);
    const loaded = loadPendingFixes(tmpDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('new');
  });

  it('can save an empty array to clear the manifest', () => {
    savePendingFixes(tmpDir, [makePendingFix()]);
    savePendingFixes(tmpDir, []);
    expect(loadPendingFixes(tmpDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolvePlaywrightConfig
// ---------------------------------------------------------------------------

describe('resolvePlaywrightConfig', () => {
  it('returns the path from QA_COPILOT_PW_CONFIG env var when set', () => {
    const envPath = '/custom/playwright.config.ts';
    process.env['QA_COPILOT_PW_CONFIG'] = envPath;
    try {
      expect(resolvePlaywrightConfig(tmpDir, {})).toBe(envPath);
    } finally {
      delete process.env['QA_COPILOT_PW_CONFIG'];
    }
  });

  it('resolves the config path from config.json when provided', () => {
    const configPath = 'e2e/playwright.config.ts';
    const abs = path.join(tmpDir, configPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');

    const result = resolvePlaywrightConfig(tmpDir, { playwrightConfig: configPath });
    expect(result).toBe(abs);
  });

  it('auto-detects playwright.config.ts in the project root', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.ts'), '');
    expect(resolvePlaywrightConfig(tmpDir, {})).toBe(
      path.join(tmpDir, 'playwright.config.ts'),
    );
  });

  it('falls back to playwright.config.js when .ts is absent', () => {
    fs.writeFileSync(path.join(tmpDir, 'playwright.config.js'), '');
    expect(resolvePlaywrightConfig(tmpDir, {})).toBe(
      path.join(tmpDir, 'playwright.config.js'),
    );
  });

  it('returns null when no playwright config can be found', () => {
    expect(resolvePlaywrightConfig(tmpDir, {})).toBeNull();
  });
});
