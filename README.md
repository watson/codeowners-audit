<p align="center">
  <img width="328" height="300" alt="codeowners-audit logo" src="https://github.com/user-attachments/assets/ae21c52c-e923-4c43-8a13-8d22e03bc867" />
</p>

<p align="center">Generate a polished, interactive HTML report for CODEOWNERS coverage, ownership gaps, and GitHub-parity validation. Run it locally for investigation or in CI to fail when files are uncovered.</p>

<img width="1429" height="681" alt="image" src="https://github.com/user-attachments/assets/abcaddf1-4159-4278-b592-ce96a1235f8e" />

## Live Example

See how ownership coverage looks in practice with [this interactive report](https://watson.github.io/codeowners-audit/example.html) for the `nodejs/node` repository.

## Why this exists

`CODEOWNERS` is great for review routing, but it is hard to quickly answer:

- How much of this repository is actually covered?
- Which directories have the biggest ownership gaps?
- Which specific files have no matching owner rule?
- Which `CODEOWNERS` rules look valid in git, but are ignored or ineffective on GitHub?

`codeowners-audit` scans a repository, applies practical `CODEOWNERS` resolution, and produces a single self-contained HTML report you can open locally, archive in CI, or upload to a public link.

## Highlights

- Self-contained interactive HTML report
- Coverage drill-down by repository, directory, file, and resolved owner
- CI-friendly defaults that can fail builds when files are uncovered
- GitHub-parity validation for ignored `CODEOWNERS` files, missing paths, invalid owners, oversized files, and fragile coverage
- Optional team suggestions for uncovered directories based on git history
- Works on local repositories or remote GitHub repositories with a single command

## Quick Start

Run without installing:

```bash
npx codeowners-audit
```

For repeat use in a repository or CI, add it as a dev dependency:

```bash
npm install --save-dev codeowners-audit
```

Common first runs:

Generate a report for the current repository:

```bash
npx codeowners-audit
```

Fail in CI without writing HTML:

```bash
npx codeowners-audit --no-report
```

Audit a remote GitHub repository:

```bash
npx codeowners-audit watson/codeowners-audit
```

## Usage

```bash
codeowners-audit [repo-or-path] [options]
```

The executable name is `codeowners-audit`. If you are running it without installing it as a dependency, prefix commands with `npx`.

`[repo-or-path]` is optional and can be:

- A remote repository URL such as `https://github.com/owner/repo`
- GitHub shorthand such as `owner/repo`
- A local directory path such as `~/code/my-repo`
- Omitted, in which case the current working directory is used

By default, the tool:

- analyzes tracked files from `git ls-files`
- writes the report to a temporary path
- prompts you to press Enter before opening the report in your default browser

When standard input is non-interactive (no TTY, for example in CI), the command automatically behaves as if `--no-open --list-unowned --fail-on-unowned` were specified:

- it never prompts to open a browser
- it prints all unowned file paths to stdout
- it exits non-zero when uncovered files exist

Use `--output` or `--output-dir` for deterministic artifact paths, or `--no-report` to skip writing HTML entirely. In interactive mode, `--no-report` implies `--list-unowned` so the command still produces useful output.

## Options

### Input and Scope

| Option | Description |
| --- | --- |
| `--cwd <dir>` | Run git commands from this directory |
| `--include-untracked` | Include untracked files in the analysis |
| `-g, --glob <pattern>` | Repeatable file filter for report and check scope (default: `**`) |

### Report Output

| Option | Description |
| --- | --- |
| `-o, --output <path>` | Output HTML file path |
| `--output-dir <dir>` | Output directory for the generated HTML report |
| `--no-report` | Skip HTML report generation (implies `--list-unowned`) |
| `--upload` | Upload to zenbin and print a public URL |

### Interaction and Diagnostics

| Option | Description |
| --- | --- |
| `--no-open` | Do not prompt to open the report in your browser |
| `-y, --yes` | Automatically answer yes to interactive prompts |
| `--verbose` | Enable verbose progress output |
| `-h, --help` | Show this help |
| `-v, --version` | Show version |

### Core Coverage Checks

| Option | Description |
| --- | --- |
| `--list-unowned` | Print unowned file paths to stdout |
| `--fail-on-unowned` | Exit non-zero when one or more files are unowned |

### GitHub Validation and Policy Checks

| Option | Description |
| --- | --- |
| `--fail-on-oversized-codeowners` | Exit non-zero when the active `CODEOWNERS` file exceeds GitHub's 3 MB limit |
| `--fail-on-missing-paths` | Exit non-zero when one or more `CODEOWNERS` paths match no repository files |
| `--validate-github-owners` | Validate `@username` and `@org/team` owners against GitHub and use only validated owners for coverage |
| `--fail-on-invalid-owners` | Exit non-zero when one or more `CODEOWNERS` rules contain invalid GitHub owners |
| `--fail-on-missing-directory-slashes` | Exit non-zero when directory `CODEOWNERS` paths do not follow the explicit trailing-slash style |
| `--fail-on-location-warnings` | Exit non-zero when extra or ignored `CODEOWNERS` files are found |
| `--fail-on-fragile-coverage` | Exit non-zero when directories have fragile file-by-file coverage |

### Team Suggestions

| Option | Description |
| --- | --- |
| `--suggest-teams` | Suggest `@org/team` for uncovered directories |
| `--suggest-window-days <days>` | Git history lookback window for suggestions (default: `365`) |
| `--suggest-top <n>` | Top team suggestions to keep per directory (default: `3`) |
| `--suggest-ignore-teams <list>` | Comma-separated team slugs or `@org/slug` entries to exclude from suggestions |
| `--github-org <org>` | Override GitHub org for team lookups |
| `--github-token <token>` | GitHub token for team lookups (falls back to `GITHUB_TOKEN`, then `GH_TOKEN`) |
| `--github-api-base-url <url>` | GitHub API base URL (default: `https://api.github.com`) |

## Examples

Generate a report and open it after pressing Enter:

```bash
codeowners-audit
```

Write a report to a known path without opening a browser:

```bash
codeowners-audit --output codeowners-gaps-report.html --no-open
```

Run against a repository from another directory:

```bash
codeowners-audit ~/code/my-repo
```

Audit a remote GitHub repository:

```bash
codeowners-audit watson/codeowners-audit
```

Upload a report and print the public URL:

```bash
codeowners-audit --upload
```

Validate only a subset of files:

```bash
codeowners-audit --glob "src/**/*.js" --glob "test/**/*.js"
```

Suggest teams for uncovered directories:

```bash
codeowners-audit --suggest-teams
```

## Using in CI

Most CI systems, including GitHub Actions, run in a non-interactive environment. In that mode, `codeowners-audit` automatically:

- disables browser prompts with `--no-open`
- prints unowned files to stdout with `--list-unowned`
- exits `1` when uncovered files exist with `--fail-on-unowned`

Exit code behavior:

- Exit code `0`: all matched files are covered by `CODEOWNERS`, and no enabled validation policy failed
- Exit code `1`: at least one enforced policy failed, including uncovered files and any enabled `--fail-on-*` validation rule
- Exit code `2`: runtime or setup error, for example not being in a git repository, missing `CODEOWNERS`, or invalid arguments

### Common CI Commands

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

Validate only a subset, for example spec files:

```bash
codeowners-audit --glob "**/*.spec.js"
```

### GitHub Actions Example

```yaml
- name: Verify CODEOWNERS coverage
  run: npx codeowners-audit --no-report
```

## GitHub Compatibility Notes

- Follows GitHub `CODEOWNERS` discovery order: `.github/CODEOWNERS`, `CODEOWNERS`, then `docs/CODEOWNERS`
- Uses standard last-match-wins behavior, including ownerless overrides when the last matching rule has no owners
- Resolves patterns from the repository root, regardless of which supported `CODEOWNERS` location is active
- Optionally validates `@username` and `@org/team` owners against GitHub with `--validate-github-owners`
- Reports extra or ignored `CODEOWNERS` files, missing paths, fragile coverage, and unsupported syntax that GitHub would not honor

## Requirements

- `git` available on `PATH`

## Upload Size Note

zenbin currently rejects request payloads around 1 MiB and larger. Very large repositories can produce HTML reports beyond that limit, in which case `--upload` will fail with a clear size error. Use the generated local HTML file directly when this happens.

## License

MIT
