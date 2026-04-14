import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveLocalImports } from '../../../src/utils/imports';

// ---------------------------------------------------------------------------
// Helpers — build a throwaway temp dir for each test
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-copilot-imports-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): string {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveLocalImports', () => {
  it('returns an empty object when the file has no relative imports', () => {
    const entry = write('test.ts', `
      import { test } from '@playwright/test';
      import path from 'path';
    `);
    expect(resolveLocalImports(entry, tmpDir)).toEqual({});
  });

  it('resolves a direct relative import with explicit .ts extension', () => {
    write('helpers/auth.ts', 'export const login = () => {};');
    const entry = write('test.ts', `import { login } from './helpers/auth.ts';`);

    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).toContain('helpers/auth.ts');
    expect(result['helpers/auth.ts']).toContain('export const login');
  });

  it('resolves a relative import without file extension', () => {
    write('helpers/auth.ts', 'export const login = () => {};');
    const entry = write('test.ts', `import { login } from './helpers/auth';`);

    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).toContain('helpers/auth.ts');
  });

  it('resolves an index file import from a directory', () => {
    write('fixtures/index.ts', 'export const fixture = {};');
    const entry = write('test.ts', `import { fixture } from './fixtures';`);

    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).toContain('fixtures/index.ts');
  });

  it('resolves parent directory imports (../)', () => {
    write('shared/utils.ts', 'export const util = () => {};');
    // entry is in a subdirectory
    const entry = write('tests/spec.ts', `import { util } from '../shared/utils';`);

    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).toContain('shared/utils.ts');
  });

  it('recurses into imported files (depth 2)', () => {
    write('utils/format.ts', 'export const fmt = (s: string) => s;');
    write('helpers/auth.ts', `
      import { fmt } from '../utils/format';
      export const login = () => fmt('ok');
    `);
    const entry = write('test.ts', `import { login } from './helpers/auth';`);

    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).toContain('helpers/auth.ts');
    expect(Object.keys(result)).toContain('utils/format.ts');
  });

  it('does not include the entry file itself', () => {
    write('helpers/auth.ts', 'export const login = () => {};');
    const entry = write('test.ts', `import { login } from './helpers/auth';`);

    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).not.toContain('test.ts');
  });

  it('does not follow node_modules imports', () => {
    const entry = write('test.ts', `
      import { test } from '@playwright/test';
      import chalk from 'chalk';
    `);

    expect(resolveLocalImports(entry, tmpDir)).toEqual({});
  });

  it('handles circular imports without looping infinitely', () => {
    write('a.ts', `import { b } from './b';`);
    write('b.ts', `import { a } from './a';`);
    const entry = write('test.ts', `import { a } from './a';`);

    // Should not throw or hang
    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).toContain('a.ts');
    expect(Object.keys(result)).toContain('b.ts');
  });

  it('silently skips imports pointing at non-existent files', () => {
    const entry = write('test.ts', `import { foo } from './does-not-exist';`);
    expect(() => resolveLocalImports(entry, tmpDir)).not.toThrow();
    expect(resolveLocalImports(entry, tmpDir)).toEqual({});
  });

  it('does not recurse beyond depth 2', () => {
    write('d3.ts', 'export const deep = 3;');
    write('d2.ts', `import { deep } from './d3'; export const d2 = deep;`);
    write('d1.ts', `import { d2 } from './d2'; export const d1 = d2;`);
    const entry = write('test.ts', `import { d1 } from './d1';`);

    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).toContain('d1.ts');  // depth 1 — included
    expect(Object.keys(result)).toContain('d2.ts');  // depth 2 — included
    expect(Object.keys(result)).not.toContain('d3.ts'); // depth 3 — excluded
  });

  it('picks up dynamic import() expressions', () => {
    write('lazy.ts', 'export const lazy = {};');
    const entry = write('test.ts', `const m = await import('./lazy');`);

    const result = resolveLocalImports(entry, tmpDir);
    expect(Object.keys(result)).toContain('lazy.ts');
  });
});
