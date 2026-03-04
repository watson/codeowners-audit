# codeowners-report

Generate a polished, interactive HTML report that shows which files in a Git repository are covered by `CODEOWNERS` rules and where ownership gaps exist.

## Live example

See how ownership coverage looks in practice with [this interactive report](https://htmlpreview.github.io/?https://raw.githubusercontent.com/watson/codeowners-report/main/example.html) for the `nodejs/node` repository.

<img width="1418" height="684" alt="image" src="https://github.com/user-attachments/assets/96794755-1baf-484b-8bb5-8e22e6a47cd7" />

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
| `-C, --working-dir <dir>` | Resolve git operations from this directory (alias: `--cwd`) |
| `--include-untracked` | Include untracked (non-ignored) files in analysis |
| `--upload` | Upload report to ZenBin and print a public URL (small reports only) |
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

Run against a repository from another directory:

```bash
codeowners-report --working-dir ~/code/my-repo
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
