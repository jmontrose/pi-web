---
description: Launch the pr-watch subagent to poll a PR for new CI failures / comments in the background. Returns only when actionable or CI settles.
argument-hint: "<pr-number-or-url> [deadline-seconds]"
---

Launch the `pr-watch` subagent as a **background** workflow to poll-watch PR **$1**.

Use this exact tool call (it suppresses mid-poll "needs attention" wakes so you are only woken on completion — do not add a `timeout` to the bash call inside; the run is configured to allow up to 40m):

```
subagent({
  async: true,
  args: { pr: "$1", deadline: ${2:-2100} },
  workflowScript: "return runs.run(\"watch\", { agent: \"pr-watch\", task: \"Poll-watch PR \" + args.pr + \" in airelabsresearch/siro. Deadline \" + args.deadline + \" seconds. Return as soon as there is a new CI failure or a new review/bot/human comment, or when all CI settles.\", control: { notifyOn: [] } })"
})
```

Notes:
- `$1` is the PR number or full github PR URL. If only a number is given, `pr-watch` derives `owner/repo` from the current repo's git remote (so run this from inside the repo, or add `--repo owner/repo` to the task).
- Default deadline is 2100s (35m), which covers a 30m moon-ci run. Pass a second arg to override, e.g. `/pr-watch 10230 1800`.
- The watcher is running only if the tool call returns a successful background run identifier. If it throws, says background children are unavailable, or returns no run identifier, report the failure prominently in the same turn. Never say or imply that monitoring is active after a failed launch.
- If background launch fails, foreground subagents still work. Fall back to `gh pr view $1 --comments` and `gh pr checks $1` at every turn boundary and whenever work resumes until a background launch succeeds.
- After launching, **return control to the user**. Pi wakes you with the result when pr-watch completes (new failure / new comment / CI settled / deadline). Do not poll or wait.
- When it returns: if actionable, address the findings (fix the failing check, reply to the comment); then relaunch `/pr-watch $1` to keep watching the next round. If it hit the deadline with checks still running, relaunch to continue.
- To start completely fresh (ignore the previous snapshot), add `--reset` to the task text, e.g. `/pr-watch 10230` then ask it to reset, or run `rm -rf ~/.pi/agent/pr-watch` and relaunch.
