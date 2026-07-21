# Portable pre-review gate registration

The pre-review gate runs before shell commands in a project worktree. It must
inspect `PreToolUse` events for `Bash`, validate the ignored marker at
`.agents/.pre-review-passed`, and block a feature-branch `git push` or
`gh pr create` when the current diff no longer matches the reviewed base.

Client adapters register the same portable gate core without credentials or
deployment authority. The Claude adapter invokes its compatibility wrapper;
the Codex adapter invokes `scripts/ai/pre_review_gate.py` directly.
