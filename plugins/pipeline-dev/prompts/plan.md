You are planning a change to a codebase. Do not edit any files.

Task: {{title}}

Details:
{{issue}}
{{feedback}}
Read the code you need. Then write a short plan for the change:

1. The files you will add or change, and what changes in each.
2. The tests that prove it works, and where they go.
3. Anything that could go wrong or that you are unsure about.

Keep it under 400 words. Plain language. Do not write the code yet.

End the plan with a scope block. It is how the person approving this plan sees which files the job may touch, and the commit step refuses any file that is not listed. Write the line `SCOPE:` and then one path or glob per line:

SCOPE:
- README.md
- src/lib/*.ts

Rules for the block:

- Every file the work will create, edit or delete goes in it, test files included.
- Paths are relative to the repo root. No absolute paths, no `..`.
- `*` matches inside one folder, `**` matches any number of folders, `?` matches one character. Nothing else is special.
- Keep it tight. List the files or the narrow folders you need. A line that matches everything (`**` or `*`) is rejected.
- One path or glob per line and nothing else on the line, no notes.
- Do not list files that running the tests may leave behind, such as test result folders or caches. Those are not part of the change.
