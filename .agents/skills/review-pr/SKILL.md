---
name: review-pr
description:
  Review a pull request diff and write structured feedback to review.json for the workflow to
  publish.
---

# Review PR Skill

Review the current pull request and write the output to `review.json`.

## Context

- The working directory is the PR branch checkout.
- The workflow provides an annotated diff in `pr_diff.txt`.
- The workflow provides the PR description in `pr_description.txt`.
- The workflow provides existing PR comments (if any) in `pr_comments.txt`.
- Focus on files and lines changed by this PR.
- Do not post comments or reviews to GitHub directly.

## Existing PR Comments

Before writing your review, read `pr_comments.txt`. Use these comments to:

- Understand design decisions explained by the author or other reviewers.
- Incorporate context from prior review feedback into your analysis.
- Avoid repeating points already raised. If an existing comment covers a concern you would raise,
  skip it. You may add a clarification comment if the existing comment does not fully express your
  concern.
- If you disagree with an existing comment, you may note it in the summary but do not leave a
  duplicate inline comment.

The `pr_comments.txt` file will only exist if there were existing comments on the PR.

## Review Scope

- Prioritize correctness, security, error handling, and meaningful performance issues.
- Include style or nit comments only when you can provide a concrete suggestion block.
- If a concern involves untouched code, mention it in the summary instead of an inline comment.

## Binary Files

Binary files (images, compiled assets, etc.) appear in the diff as:

```
diff --git a/path/to/file b/path/to/file
Binary files /dev/null and b/path/to/file differ
```

They have no line annotations. Comments on binary files must:

- Include only `path` and `body`. Do not include `line`, `start_line`, or `side`.
- Not include suggestion blocks (there is no source text to replace).

## Diff Line Annotations

The diff file uses these prefixes for text files:

- `[OLD:n]` for deleted lines on the old side. Use `"LEFT"`.
- `[NEW:n]` for added lines on the new side. Use `"RIGHT"`.
- `[OLD:n,NEW:m]` for unchanged context. Use `"RIGHT"` with line `m`.

## Comment Requirements

Every comment body must start with one of these labels:

- `🚨 [CRITICAL]` for bugs, security issues, crashes, or data loss.
- `⚠️ [IMPORTANT]` for logic problems, edge cases, or missing error handling.
- `💡 [SUGGESTION]` for worthwhile improvements or better patterns.
- `🧹 [NIT]` for cleanup only when the comment includes a suggestion block.

Write comments with these constraints:

- Be concise, direct, and actionable.
- Do not add compliments or hedging.
- Prefer single-line comments.
- Keep ranges to at most 10 lines.
- Restrict inline comments to valid changed lines in this PR.

## Suggestion Blocks

When proposing a code change, use:

```suggestion
<replacement code here>
```

Rules:

- Match the exact indentation of the original file.
- Include only replacement code.
- For multi-line suggestions, set `start_line` to the first line and `line` to the last line.

## Output Format

Create `review.json` with this shape:

````json
{
  "summary": "## Overview\n...\n\n## Concerns\n- ...\n\n## Verdict\nFound: 1 critical, 2 important, 3 suggestions\n\n**Request changes**",
  "comments": [
    {
      "path": "path/to/file",
      "line": 42,
      "side": "RIGHT",
      "start_line": 40,
      "body": "⚠️ [IMPORTANT] Short explanation\n\n```suggestion\nreplacement\n```"
    },
    {
      "path": "assets/logo.png",
      "body": "💡 [SUGGESTION] Consider compressing this image to reduce bundle size."
    }
  ]
}
````

Field rules:

- `path` must be relative to the repository root.
- For text files: `line` is required and must target the correct side. `side` must be `"LEFT"` or
  `"RIGHT"`. `start_line` is optional and only for multi-line ranges.
- For binary files: `line`, `start_line`, and `side` must be omitted. Only `path` and `body` are
  allowed.

## Summary Requirements

The `summary` must include:

- A high-level overview of the PR.
- Important concerns and any untouched-code concerns that could not be commented inline.
- Issue counts in the format `Found: X critical, Y important, Z suggestions`.
- A final recommendation of `Approve`, `Approve with nits`, or `Request changes`.

## Final Checks

Before finishing:

- Validate `review.json` with `jq`.
- Fix invalid JSON if validation fails.
- Confirm line numbers match the annotated diff.
- Do not run `gh pr review`, `gh pr comment`, `gh api`, or any other command that posts to GitHub.

Your only output is the final `review.json`.
