# codeowners-report

Generate a polished, interactive HTML report that shows which files in a Git repository are covered by `CODEOWNERS` rules and where ownership gaps exist.

## Why this exists

`CODEOWNERS` is great for review routing, but it is hard to quickly answer:

- How much of this repository is actually covered?
- Which directories have the biggest ownership gaps?
- Which specific files have no matching owner rule?

`codeowners-report` scans your repository, applies `CODEOWNERS` matching rules, and produces a single self-contained HTML report you can open locally or upload to a public link.

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
npx codeowners-report
```

Or install globally:

```bash
npm install -g codeowners-report
codeowners-report
```

## Usage

Run this inside a Git repository:

```bash
codeowners-report [options]
```

By default, the tool:

- analyzes tracked files from `git ls-files`
- writes the report to a temporary path
- opens the report in your default browser

### Options

| Option | Description |
| --- | --- |
| `-o, --output <path>` | Output HTML file path |
| `--output-dir <dir>` | Output directory for the generated report |
| `--include-untracked` | Include untracked (non-ignored) files in analysis |
| `--upload` | Upload report to ZenBin and print a public URL |
| `--no-open` | Do not open the report automatically |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Examples

Generate report and open it automatically:

```bash
codeowners-report
```

Upload report and open the shared URL:

```bash
codeowners-report --upload
```

Write report to repository:

```bash
codeowners-report --output codeowners-gaps-report.html --no-open
```

Write report to a specific folder:

```bash
codeowners-report --output-dir reports --no-open
```

Include untracked files in analysis:

```bash
codeowners-report --include-untracked --output reports/all-files.html --no-open
```

## How matching works

The report follows practical `CODEOWNERS` resolution behavior:

- A file is considered **owned** if at least one owner is resolved.
- Within a single `CODEOWNERS` file, the **last matching rule wins**.
- If multiple `CODEOWNERS` files exist, they are applied from broader scope to narrower scope (nested files can override broader files).
- `CODEOWNERS` negation patterns (`!pattern`) are ignored.

## Requirements

- Git CLI available on `PATH`
- `curl` available on `PATH` when using `--upload`

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
