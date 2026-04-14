# QA Copilot

An AI-powered Playwright test copilot for TypeScript projects. Watches your tests run, diagnoses failures with a local LLM, proposes diffs you can accept or reject, and generates commit messages for fixes you apply.

Runs entirely locally via [Ollama](https://ollama.com) — no API keys, no data leaves your machine.

---

## Requirements

- **Node.js** ≥ 18
- **Ollama** running locally (`ollama serve`)
- A code model pulled, e.g. `ollama pull qwen2.5-coder:14b`
- A vision model pulled for screenshot analysis, e.g. `ollama pull llava:7b`
- A Playwright project using TypeScript (`playwright.config.ts`)

---

## Installation

```bash
git clone <this-repo>
cd qa-copilot
npm install
npm run build
npm link          # makes `qa-copilot` available globally
```

---

## Before You Begin — Target Project Setup

Before pointing QA Copilot at a Playwright project, make sure that project is configured to capture screenshots on failure. Without this, the AI will diagnose failures from error messages and stack traces alone — which still works, but you lose the visual context that makes diagnosis significantly more accurate.

Add the following to the target project's `playwright.config.ts`:

```typescript
export default defineConfig({
  use: {
    screenshot: 'only-on-failure',
  },
});
```

> **Why this matters:** Playwright attaches screenshots to the test result object when a test fails. QA Copilot's reporter reads those attachments and passes them through a vision model before diagnosis — giving the coder model a description of what the page actually looked like at the moment of failure, not just what the error said.

---

## Quick Start

```bash
cd your-playwright-project

# One-time setup (recommended)
qa-copilot init

# Run tests with AI diagnosis
qa-copilot run

# Review and apply suggested fixes
qa-copilot fix
```

---

## Commands

### `qa-copilot init`

Interactive setup wizard. Run once per project.

```bash
qa-copilot init
```

**What it does:**
- Checks Ollama is reachable and lists available models
- Lets you select your code model and vision model
- Detects your `playwright.config.ts` and confirms the path
- Writes `.qa-copilot/config.json` with your choices
- Adds `.qa-copilot/pending-fixes.json` to `.gitignore` (that file contains full test source and should not be committed)

Without `init`, QA Copilot still works — it falls back to `qwen2.5-coder:14b` and auto-discovers `playwright.config.ts` from the current directory.

---

### `qa-copilot run [-- <playwright args>]`

Runs your Playwright test suite with the QA Copilot reporter injected.

```bash
qa-copilot run                              # all tests
qa-copilot run -- --headed                  # headed mode
qa-copilot run -- tests/login.spec.ts       # single file
qa-copilot run -- --grep "checkout"         # grep filter
```

**What it does:**
1. Verifies Ollama is running and the configured model is available
2. Locates your `playwright.config.ts`
3. Spawns `npx playwright test` with the QA Copilot reporter injected via `--reporter`
4. For each failing test, streams AI diagnosis and a proposed fix to the terminal in real time
5. If a failure includes a screenshot attachment, a vision model analyzes it first and the visual description is folded into the diagnosis
6. Writes all proposed fixes to `.qa-copilot/pending-fixes.json`

The reporter is injected additively — any reporters already configured in your `playwright.config.ts` continue to run unchanged.

---

### `qa-copilot fix`

Interactive fix review. Walk through each proposed fix, see a colored diff, and accept or skip.

```bash
qa-copilot fix
```

**What it does:**
1. Loads `.qa-copilot/pending-fixes.json`
2. For each pending fix, shows:
   - The test title and file
   - The error message
   - The AI diagnosis
   - A colored unified diff of the proposed change
3. Prompts: **Yes (apply)**, **No (skip)**, or **Quit** (saves state, resume later)
4. Writes accepted fixes directly to the test files
5. After review, optionally generates an AI commit message for everything that was applied

---

### `qa-copilot status`

Show the current fix manifest without entering review mode.

```bash
qa-copilot status
```

Prints each fix with its state (`pending`, `accepted`, or `rejected`).

---

### `qa-copilot inspect`

Submit a screenshot and description of a visual regression your tests aren't catching. The copilot analyzes the image and suggests a test addition or modification to catch the failure.

```bash
# Interactive (prompts for all inputs)
qa-copilot inspect

# With flags
qa-copilot inspect \
  --screenshot ./screenshots/regression.png \
  --context "Dropdown overlaps the submit button on mobile viewport" \
  --test tests/checkout.spec.ts
```

**Flags:**

| Flag | Description |
|---|---|
| `--screenshot <path>` | Path to a screenshot of the regression (PNG or JPEG) |
| `--context <text>` | Plain-language description of what's visually wrong |
| `--test <path>` | Path to the test file to modify (optional — if omitted, copilot suggests a new test) |

**What it does:**
1. Reads the screenshot and encodes it for the vision model
2. Vision model describes what it observes and identifies the visual problem
3. Coder model reads the test file (or is told to write a new one) and suggests a fix that would catch the regression
4. Fix is added to `.qa-copilot/pending-fixes.json` — review and apply with `qa-copilot fix`

---

## Configuration

QA Copilot looks for `.qa-copilot/config.json` in your project root.

```json
{
  "ollamaUrl": "http://localhost:11434",
  "model": "qwen2.5-coder:14b",
  "visionModel": "llava:7b",
  "playwrightConfig": "playwright.config.ts"
}
```

All fields are optional. Environment variables override config file values:

| Env var | Overrides |
|---|---|
| `QA_COPILOT_OLLAMA_URL` | `ollamaUrl` |
| `QA_COPILOT_MODEL` | `model` |
| `QA_COPILOT_VISION_MODEL` | `visionModel` |
| `QA_COPILOT_PW_CONFIG` | `playwrightConfig` |

---

## How Playwright Screenshot Capture Works

For automatic screenshot diagnosis to work, configure Playwright to capture screenshots on failure:

```typescript
// playwright.config.ts
export default defineConfig({
  use: {
    screenshot: 'only-on-failure',
  },
});
```

QA Copilot reads `result.attachments` from the Playwright Reporter API — no extra configuration needed beyond the above.

---

## `.qa-copilot/` directory

| File | Purpose |
|---|---|
| `config.json` | Your project's QA Copilot settings (safe to commit) |
| `pending-fixes.json` | Fix manifest from the last run — **do not commit** (contains full test source) |

`init` adds `pending-fixes.json` to your `.gitignore` automatically.

---

## Model Recommendations

| Task | Recommended model | Notes |
|---|---|---|
| Code diagnosis + fix | `qwen2.5-coder:14b` | Tuned on code; best balance of speed and quality at 14B |
| Screenshot analysis | `llava:7b` | Widely available, solid UI understanding |
| Screenshot analysis (higher quality) | `qwen2.5vl:7b` | Better reasoning about UI layout and state |

Pull models with `ollama pull <model-name>`.
