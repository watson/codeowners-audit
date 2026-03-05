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
- prompts you to press Enter before opening the report in your default browser

When standard input is non-interactive (no TTY), the command automatically behaves as if
`--no-open --list-unowned --fail-on-unowned` were specified:
- it never prompts to open a browser
- it prints all unowned file paths to stdout
- it exits non-zero when uncovered files exist

Use `--output` or `--output-dir` for deterministic artifact paths, or `--no-report` to skip writing HTML entirely.
In interactive mode, `--no-report` implies `--list-unowned` so output still stays useful.

### Options

| Option | Description |
| --- | --- |
| `-o, --output <path>` | Output HTML file path |
| `--output-dir <dir>` | Output directory for the generated HTML report |
| `--cwd <dir>` | Run git commands from this directory |
| `--include-untracked` | Include untracked files in the analysis |
| `--no-report` | Skip HTML report generation (implies `--list-unowned`) |
| `--list-unowned` | Print unowned file paths to stdout |
| `--fail-on-unowned` | Exit non-zero when one or more files are unowned |
| `-g, --glob <pattern>` | Repeatable file filter for report/check scope (default: `**`) |
| `--suggest-teams` | Suggest `@org/team` for uncovered directories |
| `--suggest-window-days <days>` | Git history lookback window for suggestions (default: `365`) |
| `--suggest-top <n>` | Top team suggestions to keep per directory (default: `3`) |
| `--suggest-ignore-teams <list>` | Comma-separated team slugs or `@org/slug` entries to exclude from suggestions |
| `--github-org <org>` | Override GitHub org for team lookups |
| `--github-token <token>` | GitHub token for team lookups (falls back to `GITHUB_TOKEN`, then `GH_TOKEN`) |
| `--github-api-base-url <url>` | GitHub API base URL (default: `https://api.github.com`) |
| `--upload` | Upload to zenbin and print a public URL |
| `--no-open` | Do not prompt to open the report in your browser |
| `--verbose` | Enable verbose progress output |
| `-h, --help` | Show this help |
| `-v, --version` | Show version |

## Examples

Generate report and open it after pressing Enter:

```bash
codeowners-audit
```

Upload report and open the shared URL after pressing Enter:

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

Most CI systems (including GitHub Actions) run in a non-interactive environment (no TTY on stdin).
In non-interactive environments, `codeowners-audit` automatically:
- disables browser prompts (`--no-open`)
- prints unowned files to stdout (`--list-unowned`)
- exits `1` when unowned files exist (`--fail-on-unowned`)

Exit code behavior:
- Exit code `0`: all matched files are covered by `CODEOWNERS`.
- Exit code `1`: one or more matched files are uncovered.
- Exit code `2`: runtime/setup error (for example: not in a Git repository, missing `CODEOWNERS`, invalid arguments).

### Common CI commands

Validate all tracked files:

```bash
codeowners-audit
```

Validate all tracked files without writing HTML:

```bash
codeowners-audit --no-report
```

Validate and write a report artifact to a known path:

```bash
codeowners-audit --output codeowners-gaps-report.html
```

Validate and write reports into an artifact directory:

```bash
codeowners-audit --output-dir artifacts
```

Validate only a subset (for example spec files):

```bash
codeowners-audit --glob "**/*.spec.js"
```

Validate multiple subsets in one run (combined as a union):

```bash
codeowners-audit --glob "src/**/*.js" --glob "test/**/*.js"
```

### GitHub Actions example

```yaml
- name: Verify CODEOWNERS coverage
  run: npx codeowners-audit --no-report
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
