# codeowners-audit

Generate a polished, interactive HTML report that shows which files in a Git repository are covered by `CODEOWNERS` rules and where ownership gaps exist. You can also run it in CI or from the command line to fail when files are not covered by CODEOWNERS.

## Live example

See how ownership coverage looks in practice with [this interactive report](https://htmlpreview.github.io/?https://raw.githubusercontent.com/watson/codeowners-audit/main/example.html) for the `nodejs/node` repository.

<img width="1429" height="681" alt="image" src="https://github.com/user-attachments/assets/abcaddf1-4159-4278-b592-ce96a1235f8e" />

## Why this exists

`CODEOWNERS` is great for review routing, but it is hard to quickly answer:

- How much of this repository is actually covered?
- Which directories have the biggest ownership gaps?
- Which specific files have no matching owner rule?

`codeowners-audit` scans your repository, applies `CODEOWNERS` matching rules, and produces a single self-contained HTML report you can open locally or upload to a public link.

## Highlights

- Interactive HTML report with no build step
- Coverage summary: total files, owned, unowned, and percentage
- Top-level hotspot view to prioritize high-impact gaps
- Directory explorer with filtering, sorting, and drill-down
- Full unowned file list with scope and text filtering
- Supports multiple `CODEOWNERS` files in nested directories
- Optional upload to [zenbin.org](https://zenbin.org) for easy sharing

## Installation

Run with `npx` (no install):

```bash
npx codeowners-audit
```

Or install globally:

```bash
npm install -g codeowners-audit
codeowners-audit
```

## Usage

Run this inside a Git repository:

```bash
codeowners-audit [options]
```

By default, the tool:

- analyzes tracked files from `git ls-files`
- writes the report to a temporary path
- opens the report in your default browser

For CI checks where you do not want an HTML report, use `--ci`.

### Options

| Option | Description |
| --- | --- |
| `-o, --output <path>` | Output HTML file path |
| `--output-dir <dir>` | Output directory for the generated report |
| `--cwd <dir>` | Resolve git operations from this directory |
| `--include-untracked` | Include untracked (non-ignored) files in analysis |
| `--ci` | CI check mode. No report is generated; exits non-zero if uncovered files are found |
| `-g, --glob <pattern>` | Repeatable file filter for report/check scope. Defaults to all files via `**` when omitted |
| `--upload` | Upload report to ZenBin and print a public URL (small reports only) |
| `--no-open` | Do not open the report automatically |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Examples

Generate report and open it automatically:

```bash
codeowners-audit
```

Upload report and open the shared URL:

```bash
codeowners-audit --upload
```

Write report to repository:

```bash
codeowners-audit --output codeowners-gaps-report.html --no-open
```

Run against a repository from another directory:

```bash
codeowners-audit --cwd ~/code/my-repo
```

## Using in CI

Use `--ci` to turn `codeowners-audit` into a CI gate.
In this mode no HTML report is generated; the command only validates ownership coverage.

### What happens in `--ci` mode

- Exit code `0`: all matched files are covered by `CODEOWNERS`.
- Exit code `1`: one or more matched files are uncovered (the uncovered file paths are printed to stderr).
- Exit code `2`: runtime/setup error (for example: not in a Git repository, missing `CODEOWNERS`, invalid arguments).

### Common CI commands

Validate all tracked files:

```bash
codeowners-audit --ci
```

Validate only a subset (for example spec files):

```bash
codeowners-audit --ci --glob "**/*.spec.js"
```

Validate multiple subsets in one run (combined as a union):

```bash
codeowners-audit --ci --glob "src/**/*.js" --glob "test/**/*.js"
```

### GitHub Actions example

```yaml
- name: Verify CODEOWNERS coverage
  run: npx codeowners-audit --ci
```

## How matching works

The report follows practical `CODEOWNERS` resolution behavior:

- A file is considered **owned** if at least one owner is resolved.
- Within a single `CODEOWNERS` file, the **last matching rule wins**.
- If multiple `CODEOWNERS` files exist, they are applied from broader scope to narrower scope (nested files can override broader files).
- Directory rules match descendant files whether they are written as `/path/to/dir` or `/path/to/dir/`.
- `CODEOWNERS` negation patterns (`!pattern`) are ignored.

## Requirements

- Git CLI available on `PATH`
- `curl` available on `PATH` when using `--upload`

## Upload size note

ZenBin currently rejects request payloads around 1 MiB and larger. Very large repositories can produce HTML reports beyond that limit, in which case `--upload` will fail with a clear size error. Use the generated local HTML file directly when this happens.

## Report contents

The generated page includes:

- repository-level ownership metrics and coverage bar
- top-level hotspots for missing ownership
- scoped directory table with coverage bars
- searchable list of unowned files
- detected `CODEOWNERS` files and rule counts

The report is self-contained, so it can be opened directly from disk or shared after upload.

## License

MIT
