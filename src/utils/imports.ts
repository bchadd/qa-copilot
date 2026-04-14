/**
 * Resolves local TypeScript imports from a test file so the LLM gets full
 * context about fixtures, helpers, and shared page-objects the test depends on.
 *
 * Only follows relative imports (./foo, ../bar) — node_modules are skipped
 * because they'd balloon the prompt and the model already knows Playwright's API.
 *
 * Depth is capped at 2 to avoid walking an entire monorepo.
 */

import fs from 'fs';
import path from 'path';

const MAX_DEPTH = 2;
// Candidate extensions to try when an import has no extension
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/**
 * Returns a map of { relativeFilePath → fileContents } for all local imports
 * reachable from `entryFilePath` within `MAX_DEPTH` hops.
 * The entry file itself is NOT included — callers already have it.
 */
export function resolveLocalImports(
  entryFilePath: string,
  projectRoot: string,
): Record<string, string> {
  const visited = new Set<string>();
  const result: Record<string, string> = {};

  function walk(filePath: string, depth: number): void {
    if (depth >= MAX_DEPTH) return;
    if (visited.has(filePath)) return;
    visited.add(filePath);

    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return; // file unreadable — skip silently
    }

    const imports = extractRelativeImports(source);

    for (const importPath of imports) {
      const resolved = resolveImportPath(filePath, importPath);
      if (!resolved) continue;
      if (visited.has(resolved)) continue;

      let fileSource: string;
      try {
        fileSource = fs.readFileSync(resolved, 'utf-8');
      } catch {
        continue;
      }

      const relKey = path.relative(projectRoot, resolved);
      result[relKey] = fileSource;

      // Recurse into this file's imports
      walk(resolved, depth + 1);
    }
  }

  walk(entryFilePath, 0);
  return result;
}

/**
 * Extract all relative import/require paths from TypeScript source.
 * Matches: import ... from './foo'  |  require('./foo')  |  import('./foo')
 */
function extractRelativeImports(source: string): string[] {
  const results: string[] = [];
  // Static imports: from './path' or from "../path"
  const staticRe = /from\s+['"](\.[^'"]+)['"]/g;
  // Dynamic imports and requires: import('./path') or require('./path')
  const dynamicRe = /(?:import|require)\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(source)) !== null) {
    results.push(match[1]!);
  }
  while ((match = dynamicRe.exec(source)) !== null) {
    results.push(match[1]!);
  }

  return results;
}

/**
 * Given a file that contains `import ... from importPath`, resolve the
 * absolute path of the imported file. Returns null if it can't be found.
 */
function resolveImportPath(fromFile: string, importPath: string): string | null {
  const dir = path.dirname(fromFile);
  const candidate = path.resolve(dir, importPath);

  // If the import already has an extension and the file exists, use it
  if (path.extname(candidate) && fs.existsSync(candidate)) {
    return candidate;
  }

  // Try appending known extensions
  for (const ext of EXTENSIONS) {
    const withExt = candidate + ext;
    if (fs.existsSync(withExt)) return withExt;
  }

  return null;
}
