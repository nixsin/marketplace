---
description: Rerun CI checks on GitHub for a PR or branch
argument-hint: "[PR number or branch name] [--failed]"
allowed-tools: Bash(gh pr checks:*), Bash(gh pr view:*), Bash(gh run list:*), Bash(gh run rerun:*), Bash(git branch:*)
---

Rerun the GitHub Actions CI workflow for: $ARGUMENTS

Steps:
1. Figure out the target:
   - If `$ARGUMENTS` includes a number, treat it as a PR number and resolve its branch with `gh pr view <number> --json headRefName --jq .headRefName`.
   - If `$ARGUMENTS` includes a branch name, use it directly.
   - If `$ARGUMENTS` is empty, use the current branch (`git branch --show-current`).
2. Find the most recent `CI` workflow run for that branch: `gh run list --branch <branch> --workflow CI --limit 1 --json databaseId,status,conclusion`.
3. Rerun it:
   - If `$ARGUMENTS` contains `--failed`, rerun only failed jobs: `gh run rerun <run-id> --failed`.
   - Otherwise rerun the whole run: `gh run rerun <run-id>`.
4. Report back which run was rerun (with its URL) and whether it was a full or failed-only rerun. Don't poll or watch it to completion unless asked — just confirm it was triggered.

If no run is found for the branch, say so plainly rather than guessing — don't fall back to a different branch or workflow.
