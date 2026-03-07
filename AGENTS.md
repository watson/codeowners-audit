# AGENTS.md

## Commit Conventions

- **IMPORTANT:** All commit message must follow the Conventional Commits standard and be prefixed with either: `feat`, `fix`, `perf`, `docs`, `test`, `ci`, `refactor`, `build`, or `chore`.
- **IMPORTANT:** Each line in the commit message must be 100 chars or less.
- Use a scope if it clarifies the change, for example `ci(commitlint): ...`.
- Keep the subject concise and descriptive.
- Add a descriptive body that not only explains WHAT changed, but also WHY the change was made.
- Use `npm run lint:commit` to validate the latest commit locally, or pipe a draft message into `npm run lint:commit:message` before committing.
