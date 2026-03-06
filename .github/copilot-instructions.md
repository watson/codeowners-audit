# Copilot Instructions

## Project Overview

`codeowners-audit` is a Node.js CLI tool and library that generates an interactive HTML report showing CODEOWNERS coverage gaps in a Git repository. It can also run in CI to fail when files are not covered by CODEOWNERS rules.

## Tech Stack

- **Runtime**: Node.js (ESM modules — `"type": "module"` in `package.json`)
- **No build step**: source files are run directly with Node.js
- **No external runtime dependencies**: only Node.js built-ins and `git` on `PATH`
- **Dev dependencies**: commitlint, semantic-release

## Repository Structure

```
report.js               # Main CLI entry point
lib/
  github-api.js         # GitHub REST API helpers (pagination, auth)
  progress.js           # CLI progress/spinner utilities
  team-suggestions.js   # Team suggestion logic based on git history
report.template.html    # HTML template for the generated report
assets/                 # Static assets (logo)
test/
  cli.test.js           # End-to-end CLI tests
  semantic-release-publishable.test.js  # Package publishability tests
scripts/                # Maintenance scripts
```

## Testing

Run all tests with:

```bash
npm test
```

Tests use Node.js's built-in test runner (`node --test`) — no Jest, Mocha, or other test framework is needed or used. Tests are located in the `test/` directory and use the `.test.js` suffix.

## Commit Conventions

This repository uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit must have a type prefix:

- `feat` — new feature
- `fix` — bug fix
- `perf` — performance improvement
- `docs` — documentation only
- `test` — adding or updating tests
- `ci` — CI/CD configuration
- `refactor` — code refactoring (no behavior change)
- `build` — build system or dependency changes
- `chore` — maintenance tasks (e.g. `chore(release): ...`)

Keep the subject concise. Use a scope when it clarifies the change (e.g. `ci(commitlint): ...`). Body lines must be wrapped to 100 characters or less.

Validate commits locally:

```bash
npm run lint:commit           # validate the latest commit
npm run lint:commit:message   # pipe a draft message to validate before committing
```

## Code Style

- Use ES module syntax (`import`/`export`) throughout — no CommonJS `require()`
- Use JSDoc comments on exported functions and non-obvious helpers
- Prefer Node.js built-in modules over third-party packages
- Keep constants at the top of each file in `SCREAMING_SNAKE_CASE`
- ANSI color codes are defined as named constants (e.g. `ANSI_RED`, `ANSI_BOLD`)

## Key Behaviors to Preserve

- In non-interactive environments (no TTY on stdin), the CLI automatically enables `--no-open`, `--list-unowned`, and `--fail-on-unowned`
- Exit code `0` = all files covered; exit code `1` = uncovered files or check failures; exit code `2` = runtime/setup error
- CODEOWNERS discovery precedence: `.github/CODEOWNERS` → `CODEOWNERS` → `docs/CODEOWNERS` (first found wins)
- Within a single CODEOWNERS file, the **last matching rule wins**
