<p align="center">
  <img width="328" height="300" alt="codeowners-audit logo" src="https://github.com/user-attachments/assets/ae21c52c-e923-4c43-8a13-8d22e03bc867" />
</p>

<p align="center">Generate a polished, interactive HTML report that shows which files in a Git repository are covered by CODEOWNERS rules and where ownership gaps exist. You can also run it in CI or from the command line to fail when files are not covered by CODEOWNERS.</p>

<img width="1429" height="681" alt="image" src="https://github.com/user-attachments/assets/abcaddf1-4159-4278-b592-ce96a1235f8e" />

## Playground

See how ownership coverage looks in practice with [this interactive report](https://watson.github.io/codeowners-audit/example.html) for the `nodejs/node` repository.

## Why this exists

`CODEOWNERS` is great for review routing, but it is hard to quickly answer:

- How much of this repository is actually covered?
- Which directories have the biggest ownership gaps?
- Which specific files have no matching owner rule?

`codeowners-audit` scans your repository, applies `CODEOWNERS` matching rules, and produces a single self-contained HTML report you can open locally or upload to a public link.

## Highlights

- Interactive HTML report with no build step
- Coverage summary: total files, owned, unowned, and percentage
- Directory explorer with filtering, sorting, and drill-down
- Full unowned file list with scope and text filtering
- Team ownership explorer with quick team chips and owned-file filtering
- Matches GitHub `CODEOWNERS` discovery precedence: `.github/`, repository root, then `docs/`
- Detects CODEOWNERS patterns that match no repository paths
- Detects directories with fragile coverage — 100% covered through individual file rules, but new files would lack owners
- Warns when extra or unsupported `CODEOWNERS` files will be ignored by GitHub
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

```bash
codeowners-audit [repo-or-path] [options]
```

The first argument is optional and can be:

- A **remote repository URL** (e.g. `https://github.com/owner/repo`) or **GitHub shorthand** (`owner/repo`) — the repo will be cloned into a temp directory, audited, and the clone removed automatically.
- A **local directory path** (e.g. `~/code/my-repo`) — equivalent to `--cwd`.
- **Omitted** — the current working directory is used.

By default, the tool:

- analyzes tracked files from `git ls-files`
- writes the report to a temporary path
- prompts you to press Enter before opening the report in your default browser

When standard input is non-interactive (no TTY - e.g. a CI environemnt), the command automatically behaves as if
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
| `--fail-on-missing-paths` | Exit non-zero when one or more CODEOWNERS paths match no repository files |
| `--fail-on-location-warnings` | Exit non-zero when extra or ignored `CODEOWNERS` files are found |
| `--fail-on-fragile-coverage` | Exit non-zero when directories have fragile file-by-file coverage |
| `-g, --glob <pattern>` | Repeatable file filter for report/check scope (default: `**`) |
| `--suggest-teams` | Suggest `@org/team` for uncovered directories |
| `--suggest-window-days <days>` | Git history lookback window for suggestions (default: `365`) |
| `--suggest-top <n>` | Top team suggestions to keep per directory (default: `3`) |
| `--suggest-ignore-teams <list>` | Comma-separated team slugs or `@org/slug` entries to exclude from suggestions |
| `--github-org <org>` | Override GitHub org for team lookups |
| `--github-token <token>` | GitHub token for team lookups (falls back to `GITHUB_TOKEN`, then `GH_TOKEN`) |
| `--github-api-base-url <url>` | GitHub API base URL (default: `https://api.github.com`) |
| `--upload` | Upload to zenbin and print a public URL |
| `-y, --yes` | Automatically answer yes to interactive prompts |
| `--no-open` | Do not prompt to open the report in your browser |
| `--verbose` | Enable verbose progress output |
| `-h, --help` | Show this help |
| `-v, --version` | Show version |

## Examples

Generate report and open it after pressing Enter:

```bash
codeowners-audit
```

Audit a remote GitHub repository:

```bash
codeowners-audit watson/codeowners-audit
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
codeowners-audit ~/code/my-repo
```

## Using in CI

Most CI systems (including GitHub Actions) run in a non-interactive environment (no TTY on stdin).
In non-interactive environments, `codeowners-audit` automatically:
- disables browser prompts (`--no-open`)
- prints unowned files to stdout (`--list-unowned`)
- exits `1` when unowned files exist (`--fail-on-unowned`)

Exit code behavior:
- Exit code `0`: all matched files are covered by `CODEOWNERS`.
- Exit code `1`: one or more matched files are uncovered, `--fail-on-missing-paths` is enabled and one or more CODEOWNERS paths match no repository files, `--fail-on-location-warnings` is enabled and extra or ignored `CODEOWNERS` files are found, or `--fail-on-fragile-coverage` is enabled and directories rely on individual file rules instead of directory-level patterns.
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
- GitHub only considers `CODEOWNERS` at `.github/CODEOWNERS`, `CODEOWNERS`, and `docs/CODEOWNERS`, using the first file found in that order.
- Patterns are always resolved from the repository root, regardless of which supported `CODEOWNERS` location is active.
- Extra `CODEOWNERS` files in supported locations and any `CODEOWNERS` files outside those locations are reported as ignored by GitHub.
- Directory rules match descendant files whether they are written as `/path/to/dir` or `/path/to/dir/`.
- `CODEOWNERS` negation patterns (`!pattern`) are ignored.

## Requirements

- `git` available on `PATH`

## Upload size note

ZenBin currently rejects request payloads around 1 MiB and larger. Very large repositories can produce HTML reports beyond that limit, in which case `--upload` will fail with a clear size error. Use the generated local HTML file directly when this happens.

## Report contents

The generated page includes:

- repository-level ownership metrics and coverage bar
- scoped directory table with coverage bars
- searchable list of unowned files
- team ownership explorer for filtering files by `@org/team`
- active `CODEOWNERS` file and rule count
- warnings for extra or unsupported `CODEOWNERS` files that GitHub will ignore
- warnings for CODEOWNERS patterns that match no repository paths
- warnings for directories with fragile coverage (owned through individual file rules only)

The report is self-contained, so it can be opened directly from disk or shared after upload.

## License

MIT
