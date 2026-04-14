import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    'reporter/index': 'src/reporter/index.ts',
  },
  format: ['cjs'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Reporter must be self-contained — Playwright loads it in a separate process
  noExternal: ['chalk', 'ora'],
});
