#!/usr/bin/env node
// pr-watch-fetch.mjs
//
// GitHub PR watcher for the `pr-watch` pi-subagent.
//
// Fetches a PR's general comments, inline review comments, reviews, and CI
// check runs via `gh`; diffs against the previous snapshot stored under
// ~/.pi/agent/pr-watch/<owner>__<repo>/<pr>.json; writes a new snapshot; and
// prints ONE JSON object describing what is NEW since the last watch.
//
// All diffing and state storage is deterministic here so it never depends on
// the model. The cheap agent only runs this and summarizes the JSON.
//
// Modes:
//   one-shot (default): fetch + diff once, print, exit.
//   --poll:              keep polling every --interval seconds until there is
//                        something ACTIONABLE (a new CI failure or a new
//                        review/human/bot comment), or all CI settles, or the
//                        --deadline elapses — then print one JSON and exit.
//                        The run completing is what wakes the parent; the
//                        script owns the sleep loop so the model stays idle.
//
// Usage:
//   pr-watch-fetch.mjs <pr-number-or-url> [--repo owner/repo] [--reset]
//                      [--poll [--interval <sec>] [--deadline <sec>]]
//
// Exits 0 and prints JSON on stdout (including on error) so the agent can
// always parse stdout. Errors surface as { "error": "..." }.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STATE_ROOT = join(homedir(), ".pi", "agent", "pr-watch");
const FAILURE_SET = new Set([
  "FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "CANCELLED", "STALE", "STARTUP_FAILURE",
]);
const RUNNING_SET = new Set(["IN_PROGRESS", "QUEUED", "WAITING", "PENDING", "REQUESTED"]);
const MAX_EXCERPT = 280;
const DEFAULT_INTERVAL_SEC = 60;
const DEFAULT_DEADLINE_SEC = 2100; // 35m — covers a 30m moon-ci run + buffer

const BOT_LOGIN_RE =
  /^(github-actions|dependabot|dependabot-preview|vercel|netlify|copilot|copilot-pull-request-reviewer|cursor|cursor-bot|cursorbugbot|bugbot|renovate|semantic-release-bot|allcontributors|codeql|sonarcloud|codecov|coveralls)\b/i;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(msg, extra = {}) {
  emit({ error: msg, ...extra });
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch (e) {
    const stderr = (e.stderr || "").toString().trim();
    const stdout = (e.stdout || "").toString().trim();
    throw new Error(stderr || stdout || e.message);
  }
}

function gh(args) {
  return run("gh", args);
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function excerpt(s) {
  if (s == null) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > MAX_EXCERPT ? s.slice(0, MAX_EXCERPT) + "…" : s;
}

// Pure wake policy for one comment/review item, given whether the Heresy
// Check is currently failing. Exported for unit tests.
//   humans always wake; review bots (Copilot/Cursor) wake on NEW items;
//   bot edits never wake; status-bot new issue comments never wake;
//   heresy sticky comment wakes ONLY when heresy is failing (content-aware).
export function commentWake(item, opts = {}) {
  if (!item) return false;
  if (!item.bot) return true; // human
  if (isReviewBot(item.user)) return true; // Copilot / Cursor review
  if (isHeresyComment(item) && opts.heresyFailing) return true; // heresy finding
  return false; // status-bot churn (vercel, github-actions, linear, …)
}

function isBot(login, assoc) {
  if (assoc === "BOT") return true;
  if (!login) return false;
  return /\[bot\]$/i.test(login) || BOT_LOGIN_RE.test(login);
}

// Review bots whose comments/reviews carry real findings the parent wants to act
// on (Copilot code review, Cursor/Bugbot severity findings). Whitelist, not
// blacklist, so a new useful review bot surfaces as "missing" rather than
// being silently filtered. Humans are never bots, so human comments always pass.
const REVIEW_BOT_RE = /^(copilot|copilot-pull-request-reviewer|cursor|cursor-bot|cursorbugbot|bugbot)\b/i;
function isReviewBot(login) {
  if (!login) return false;
  return /\[bot\]$/i.test(login) ? REVIEW_BOT_RE.test(login) : REVIEW_BOT_RE.test(login);
}

// Status bots that post deployment/CI status churn (vercel [vc]: tokens,
// heresy sticky comments, linear linkbacks, netlify deploy tokens). Their
// comments are display-only; their FAILURES surface as checks, not comments.
const STATUS_BOT_RE =
  /^(vercel|github-actions|linear-code|linear\[bot\]|netlify|render|fly-deploy|cloudflare-pages|cloudflare-workers|deno-deploy)\b/i;
function isStatusBot(login) {
  if (!login) return false;
  return /\[bot\]$/i.test(login) ? STATUS_BOT_RE.test(login) : STATUS_BOT_RE.test(login);
}

// Is this a heresy sticky comment? The heresy workflow always posts with the
// `<!-- heresy-check -->` marker at the start (it survives the 280-char excerpt).
// Match on the marker, not just the login, so a non-heresy github-actions status
// comment isn't mistaken for a heresy finding.
const HERESY_MARKER = "<!-- heresy-check -->";
function isHeresyComment(c) {
  if (!c) return false;
  return (c.body || "").includes(HERESY_MARKER);
}

function parseArgs(argv) {
  const pos = [];
  let repo = null;
  let reset = false;
  let poll = false;
  let interval = DEFAULT_INTERVAL_SEC;
  let deadline = DEFAULT_DEADLINE_SEC;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") { repo = argv[++i]; continue; }
    if (a.startsWith("--repo=")) { repo = a.slice(7); continue; }
    if (a === "--reset") { reset = true; continue; }
    if (a === "--poll") { poll = true; continue; }
    if (a === "--interval") { interval = Number(argv[++i]); continue; }
    if (a.startsWith("--interval=")) { interval = Number(a.slice(11)); continue; }
    if (a === "--deadline") { deadline = Number(argv[++i]); continue; }
    if (a.startsWith("--deadline=")) { deadline = Number(a.slice(11)); continue; }
    pos.push(a);
  }
  if (!Number.isFinite(interval) || interval < 5) interval = DEFAULT_INTERVAL_SEC;
  if (!Number.isFinite(deadline) || deadline < interval) deadline = DEFAULT_DEADLINE_SEC;

  let owner = null, name = null, pr = null;
  const target = pos[0];
  if (!target) fail("usage: pr-watch-fetch.mjs <pr-number-or-url> [--repo owner/repo] [--reset] [--poll [--interval s] [--deadline s]]");

  const urlMatch = target.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?\/pull\/(\d+)/);
  if (urlMatch) {
    owner = urlMatch[1]; name = urlMatch[2]; pr = Number(urlMatch[3]);
  } else if (/^\d+$/.test(target)) {
    pr = Number(target);
    if (repo) {
      const m = repo.match(/^([^/]+)\/([^/]+)$/);
      if (!m) fail("--repo must be owner/repo, got: " + repo);
      owner = m[1]; name = m[2];
    } else {
      try {
        const url = run("git", ["remote", "get-url", "origin"], { cwd: process.cwd() });
        const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!m) fail("could not derive owner/repo from git remote: " + url);
        owner = m[1]; name = m[2];
      } catch (e) {
        fail("no --repo given and could not read git remote in cwd: " + e.message);
      }
    }
  } else {
    fail("target must be a PR number or a github PR url, got: " + target);
  }
  return { owner, name, pr, reset, poll, intervalMs: interval * 1000, deadlineMs: deadline * 1000 };
}

// Paginate a gh api list endpoint with per_page=100 (cap 20 pages ~2000 items).
function ghApiList(path0) {
  let out = [];
  let page = 1;
  for (;;) {
    const sep = path0.includes("?") ? "&" : "?";
    const p = `${path0}${sep}per_page=100&page=${page}`;
    let arr;
    try {
      arr = JSON.parse(gh(["api", p]));
    } catch (e) {
      throw new Error(`gh api ${p} failed: ${e.message}`);
    }
    if (!Array.isArray(arr)) return arr;
    out = out.concat(arr);
    if (arr.length < 100) break;
    page++;
    if (page > 20) break;
  }
  return out;
}

// Paginate the Actions workflow-runs envelope. Unlike review/comment endpoints,
// this endpoint returns { total_count, workflow_runs } instead of a top-level
// array, so it needs its own explicit boundary.
function ghActionsRuns(path0) {
  let out = [];
  let page = 1;
  for (;;) {
    const sep = path0.includes("?") ? "&" : "?";
    const p = `${path0}${sep}per_page=100&page=${page}`;
    let body;
    try {
      body = JSON.parse(gh(["api", p]));
    } catch (e) {
      throw new Error(`gh api ${p} failed: ${e.message}`);
    }
    const runs = body?.workflow_runs;
    if (!Array.isArray(runs)) {
      throw new Error(`gh api ${p} returned no workflow_runs array`);
    }
    out = out.concat(runs);
    if (runs.length < 100) break;
    page++;
    if (page > 20) break;
  }
  return out;
}

function statePaths(owner, name, pr, stateRoot = STATE_ROOT) {
  const dir = join(stateRoot, `${owner}__${name}`);
  return { dir, file: join(dir, `${pr}.json`) };
}

// GitHub reports missing fine-grained-token permissions through several
// surfaces and wordings. Treat those failures as deterministic capability
// gaps, not transient network errors that should be retried until deadline.
export function isAuthorizationError(error) {
  const message = String(error?.message || error || "");
  return (
    /\b(?:401|403)\b/.test(message) ||
    /resource not accessible by (?:personal access token|integration)/i.test(message) ||
    /requires? (?:the )?.*permission/i.test(message) ||
    /insufficient permissions?/i.test(message) ||
    /forbidden/i.test(message)
  );
}

function mapChecks(statusCheckRollup) {
  return (statusCheckRollup || []).map((c) => {
    if (c.__typename === "StatusContext") {
      const nm = c.context || c.name || "unknown";
      const link = c.targetUrl || c.target_url || null;
      const state = c.state || null; // ERROR/FAILURE/PENDING/SUCCESS
      return {
        key: "ctx|" + nm + "|" + (link || nm) + "|" + (state || ""),
        name: nm, typename: "StatusContext",
        status: state === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: state, startedAt: null, completedAt: null,
        link, workflowName: null,
      };
    }
    const nm = c.name || "unknown";
    const link = c.detailsUrl || c.details_url || null;
    const wf = c.workflowName || null;
    const startedAt = c.startedAt || null;
    // Stable across the running->completed transition; unique per job/shard.
    const key = "cr|" + nm + "|" + (wf || "") + "|" + (startedAt || "") + "|" + (link || "");
    return {
      key, name: nm, typename: "CheckRun",
      status: c.status, conclusion: c.conclusion,
      startedAt, completedAt: c.completedAt || null,
      link, workflowName: wf,
    };
  });
}

function normalizeActionsValue(value) {
  return value == null ? null : String(value).replaceAll("-", "_").toUpperCase();
}

// Convert current-revision Actions workflow runs to the existing check shape so
// polling, snapshot diffing, and failure wake policy remain shared. The caller
// supplies runs already filtered by GitHub to the PR head SHA; retain local
// immutable-SHA and PR-number checks so a stale or unrelated payload can never
// settle this PR. Historical runs can expose the PR's *current* nested head
// metadata, so the nested head SHA is not sufficient evidence by itself.
export function mapActionsRuns(workflowRuns, { pr, headRefOid }) {
  const current = new Map();
  for (const run of workflowRuns || []) {
    const pullRequestMatch = (run.pull_requests || []).some((item) => item?.number === pr);
    if (!pullRequestMatch || run.head_sha !== headRefOid) continue;

    const id = run.id;
    if (id == null) continue;
    const previous = current.get(id);
    if (previous && Number(previous.run_attempt || 0) > Number(run.run_attempt || 0)) continue;
    current.set(id, run);
  }

  return [...current.values()].map((run) => ({
    key: `gha|${run.id}`,
    name: run.name || run.workflow_name || run.path || "unknown",
    typename: "ActionsWorkflowRun",
    status: normalizeActionsValue(run.status),
    conclusion: normalizeActionsValue(run.conclusion),
    startedAt: run.run_started_at || run.created_at || null,
    completedAt: run.status === "completed" ? run.updated_at || null : null,
    link: run.html_url || null,
    workflowName: run.name || run.workflow_name || null,
    workflowPath: run.path || null,
  }));
}

function isMoonCi(check) {
  return (
    /(?:^|\/)moon-ci\.ya?ml(?:@|$)/i.test(check.workflowPath || "") ||
    check.name === "moon-ci" ||
    /moon[- ]?ci/i.test(check.workflowName || "")
  );
}

// Siro treats Moon CI as a required PR workflow, so seeing only a faster
// workflow is not enough evidence that Actions registration has settled. Keep
// that repository policy out of the generic watcher path: other repositories
// may not have a Moon workflow at all and should settle after the normal
// two-poll Actions stability window.
function requiresMoonCi(slug) {
  return slug.toLowerCase() === "airelabsresearch/siro";
}

// Fetch the PR, build the snapshot, diff against prev, write snapshot, and
// return the result object (baseline or diff). Does NOT emit.
function buildResult(args, deps = {}) {
  const { owner, name, pr, reset } = args;
  const slug = `${owner}/${name}`;
  const { dir, file } = statePaths(owner, name, pr, deps.stateRoot || STATE_ROOT);
  const fetchJson = deps.ghJson || ghJson;
  const fetchApiList = deps.ghApiList || ghApiList;
  const fetchActionsRuns = deps.ghActionsRuns || ghActionsRuns;

  let meta;
  try {
    meta = fetchJson([
      "pr", "view", String(pr), "--repo", slug, "--json",
      "number,state,isDraft,mergeable,mergeStateStatus,reviewDecision," +
        "headRefName,headRefOid,baseRefName,title,labels,reviewRequests," +
        "additions,deletions,changedFiles",
    ]);
  } catch (e) {
    throw new Error(`failed to fetch PR ${pr} in ${slug}: ${e.message}`);
  }

  let checks = [];
  let ciVisibility = { available: true, reason: null, message: null };
  try {
    const checkMeta = fetchJson([
      "pr", "view", String(pr), "--repo", slug, "--json", "statusCheckRollup",
    ]);
    checks = mapChecks(checkMeta.statusCheckRollup);
  } catch (e) {
    if (!isAuthorizationError(e)) {
      throw new Error(`failed to fetch PR ${pr} checks in ${slug}: ${e.message}`);
    }
    try {
      const workflowRuns = fetchActionsRuns(
        `repos/${slug}/actions/runs?event=pull_request&head_sha=${encodeURIComponent(meta.headRefOid)}`,
      );
      checks = mapActionsRuns(workflowRuns, { pr, headRefOid: meta.headRefOid });
      const moonCiRequired = requiresMoonCi(slug);
      ciVisibility = {
        available: true,
        source: "actions",
        coverage: "pull-request-actions-only",
        complete: false,
        currentRunsFound: checks.length > 0,
        moonCiRequired,
        moonCiObserved: checks.some(isMoonCi),
        reason: "checks-unavailable-actions-fallback",
        message:
          "GitHub denied Checks data. Current-revision pull_request Actions workflows are monitored; other event types and non-Actions check runs are not visible.",
      };
    } catch (actionsError) {
      if (!isAuthorizationError(actionsError)) {
        throw new Error(
          `failed to fetch PR ${pr} Actions fallback in ${slug}: ${actionsError.message}`,
        );
      }
      ciVisibility = {
        available: false,
        source: null,
        coverage: "none",
        complete: false,
        currentRunsFound: false,
        reason: "insufficient-permissions",
        message:
          "GitHub denied both Checks and Actions data. Reviews and comments were fetched, but CI cannot be monitored.",
      };
    }
  }

  let reviews, issueComments, reviewComments;
  try {
    reviews = fetchApiList(`repos/${slug}/pulls/${pr}/reviews`);
    issueComments = fetchApiList(`repos/${slug}/issues/${pr}/comments`);
    reviewComments = fetchApiList(`repos/${slug}/pulls/${pr}/comments`);
  } catch (e) {
    throw new Error(`failed to fetch PR ${pr} activity in ${slug}: ${e.message}`);
  }

  const fetchedAt = (deps.now ? deps.now() : new Date()).toISOString();

  const snapshot = {
    repo: slug, pr, fetchedAt,
    ciVisibility,
    prMeta: {
      title: meta.title, state: meta.state, isDraft: meta.isDraft,
      mergeable: meta.mergeable, mergeStateStatus: meta.mergeStateStatus,
      reviewDecision: meta.reviewDecision, headRefName: meta.headRefName,
      headRefOid: meta.headRefOid, baseRefName: meta.baseRefName,
      labels: (meta.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
      reviewRequests: (meta.reviewRequests || []).map((r) =>
        typeof r === "string" ? r : r.login || r.name || r
      ),
      additions: meta.additions, deletions: meta.deletions, changedFiles: meta.changedFiles,
    },
    checks,
    reviews: reviews.map((r) => ({
      id: r.id, state: r.state, user: r.user?.login || null,
      bot: isBot(r.user?.login, r.author_association),
      body: excerpt(r.body), submittedAt: r.submitted_at,
      commitId: r.commit_id, htmlUrl: r.html_url,
    })),
    issueComments: issueComments.map((c) => ({
      id: c.id, user: c.user?.login || null,
      bot: isBot(c.user?.login, c.author_association),
      authorAssociation: c.author_association,
      body: excerpt(c.body), createdAt: c.created_at, updatedAt: c.updated_at,
      htmlUrl: c.html_url,
    })),
    reviewComments: reviewComments.map((c) => ({
      id: c.id, reviewId: c.pull_request_review_id, user: c.user?.login || null,
      bot: isBot(c.user?.login, c.author_association),
      authorAssociation: c.author_association, body: excerpt(c.body),
      path: c.path, line: c.line, startLine: c.start_line,
      createdAt: c.created_at, updatedAt: c.updated_at,
      htmlUrl: c.html_url, commitId: c.commit_id,
    })),
  };

  if (reset && existsSync(file)) {
    try { rmSync(file); } catch { /* ignore */ }
  }

  let prev = null;
  if (existsSync(file)) {
    try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { prev = null; }
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(snapshot, null, 2));

  const runningChecks = checks.filter((c) => RUNNING_SET.has(c.status));
  const failingChecks = checks.filter((c) => c.conclusion && FAILURE_SET.has(c.conclusion));
  const passingChecks = checks.filter((c) => c.conclusion === "SUCCESS");
  const missingCurrentActions =
    ciVisibility.source === "actions" &&
    (ciVisibility.currentRunsFound === false ||
      (ciVisibility.moonCiRequired === true && ciVisibility.moonCiObserved === false));
  const missingCurrentActionsMessage = ciVisibility.currentRunsFound === false
    ? "Current-revision Actions runs have not appeared yet"
    : "Moon CI has not appeared for the current revision yet";

  // --- first watch: baseline, no diff ---
  if (!prev) {
    return {
      firstWatch: true,
      repo: slug, pr, fetchedAt,
      statePath: file,
      ciVisibility,
      counts: {
        checks: checks.length, failing: failingChecks.length,
        passing: passingChecks.length, running: runningChecks.length,
        reviews: snapshot.reviews.length, issueComments: snapshot.issueComments.length,
        reviewComments: snapshot.reviewComments.length,
      },
      prMeta: snapshot.prMeta,
      currentFailures: failingChecks.map((c) => ({
        name: c.name, workflow: c.workflowName, conclusion: c.conclusion, link: c.link,
      })),
      runningChecks: [
        ...runningChecks.map((c) => c.name),
        ...(missingCurrentActions ? [missingCurrentActionsMessage] : []),
      ],
      allTerminal: ciVisibility.available && !missingCurrentActions && runningChecks.length === 0,
      moonCiFailing: failingChecks.some(isMoonCi),
      // GitHub reports mergeable="CONFLICTING" when the head and base have
      // merge conflicts. Surface it so the parent can rebase immediately
      // instead of waiting on CI that may be red downstream of the conflict.
      mergeConflict: snapshot.prMeta.mergeable === "CONFLICTING",
      reviews: snapshot.reviews,
      issueComments: snapshot.issueComments,
      reviewComments: snapshot.reviewComments,
    };
  }

  // --- diff against prev ---
  const diff = {
    firstWatch: false,
    repo: slug, pr, fetchedAt,
    previousFetchedAt: prev.fetchedAt || null,
    statePath: file,
    ciVisibility,
    prStateChanges: [],
    newFailures: [], nowPassing: [], stillRunning: [], newChecks: [],
    newReviews: [], newIssueComments: [], newReviewComments: [], editedComments: [],
  };

  const pm = snapshot.prMeta;
  const pp = prev.prMeta || {};
  if (pm.state !== pp.state)
    diff.prStateChanges.push({ field: "state", from: pp.state, to: pm.state });
  if (pm.isDraft !== pp.isDraft)
    diff.prStateChanges.push({
      field: "draft", from: pp.isDraft, to: pm.isDraft,
      label: pm.isDraft ? "converted to draft" : "marked ready for review",
    });
  // GitHub computes mergeable/mergeStateStatus asynchronously and may return
  // "UNKNOWN" for a moment; never diff to or from it (noise flicker).
  const known = (v) => v && v !== "UNKNOWN";
  if (known(pm.mergeable) && known(pp.mergeable) && pm.mergeable !== pp.mergeable)
    diff.prStateChanges.push({ field: "mergeable", from: pp.mergeable, to: pm.mergeable });
  if (known(pm.mergeStateStatus) && known(pp.mergeStateStatus) && pm.mergeStateStatus !== pp.mergeStateStatus)
    diff.prStateChanges.push({ field: "mergeStateStatus", from: pp.mergeStateStatus, to: pm.mergeStateStatus });
  if (pm.reviewDecision !== pp.reviewDecision)
    diff.prStateChanges.push({ field: "reviewDecision", from: pp.reviewDecision || "(none)", to: pm.reviewDecision || "(none)" });
  if (pm.headRefOid && pm.headRefOid !== pp.headRefOid)
    diff.prStateChanges.push({
      field: "headRefOid", from: pp.headRefOid, to: pm.headRefOid,
      label: `new commit pushed: ${pm.headRefOid.slice(0, 7)}`,
    });
  const prevLabels = new Set(pp.labels || []);
  const curLabels = new Set(pm.labels || []);
  const addedLabels = [...curLabels].filter((l) => !prevLabels.has(l));
  const removedLabels = [...prevLabels].filter((l) => !curLabels.has(l));
  if (addedLabels.length || removedLabels.length)
    diff.prStateChanges.push({ field: "labels", added: addedLabels, removed: removedLabels });

  const prevChecks = new Map((prev.checks || []).map((c) => [c.key, c]));
  for (const c of checks) {
    const p = prevChecks.get(c.key);
    if (!p) {
      if (RUNNING_SET.has(c.status)) {
        diff.stillRunning.push({ name: c.name, workflow: c.workflowName, status: c.status, link: c.link });
      } else if (c.conclusion && FAILURE_SET.has(c.conclusion)) {
        diff.newFailures.push({ name: c.name, workflow: c.workflowName, conclusion: c.conclusion, was: null, link: c.link, completedAt: c.completedAt });
      } else {
        diff.newChecks.push({ name: c.name, workflow: c.workflowName, conclusion: c.conclusion, link: c.link });
      }
      continue;
    }
    const wasFailing = p.conclusion && FAILURE_SET.has(p.conclusion);
    const nowFailing = c.conclusion && FAILURE_SET.has(c.conclusion);
    const wasSuccess = p.conclusion === "SUCCESS";
    const nowSuccess = c.conclusion === "SUCCESS";
    if (nowFailing && !wasFailing) {
      diff.newFailures.push({ name: c.name, workflow: c.workflowName, conclusion: c.conclusion, was: p.conclusion || p.status, link: c.link, completedAt: c.completedAt });
    } else if (nowSuccess && !wasSuccess) {
      diff.nowPassing.push({ name: c.name, workflow: c.workflowName, conclusion: c.conclusion, was: p.conclusion || p.status, link: c.link });
    } else if (RUNNING_SET.has(c.status)) {
      diff.stillRunning.push({ name: c.name, workflow: c.workflowName, status: c.status, link: c.link });
    }
  }
  if (missingCurrentActions) {
    diff.stillRunning.push({
      name: missingCurrentActionsMessage,
      workflow: null,
      status: "MISSING",
      link: null,
    });
  }

  const prevReviewIds = new Set((prev.reviews || []).map((r) => r.id));
  for (const r of snapshot.reviews)
    if (!prevReviewIds.has(r.id)) diff.newReviews.push(r);

  const prevIssue = new Map((prev.issueComments || []).map((c) => [c.id, c]));
  for (const c of snapshot.issueComments) {
    const p = prevIssue.get(c.id);
    if (!p) diff.newIssueComments.push(c);
    else if (c.updatedAt && p.updatedAt && c.updatedAt !== p.updatedAt)
      diff.editedComments.push({ kind: "issue", id: c.id, user: c.user, bot: c.bot, body: c.body, link: c.htmlUrl, updatedAt: c.updatedAt });
  }

  const prevRev = new Map((prev.reviewComments || []).map((c) => [c.id, c]));
  for (const c of snapshot.reviewComments) {
    const p = prevRev.get(c.id);
    if (!p) diff.newReviewComments.push(c);
    else if (c.updatedAt && p.updatedAt && c.updatedAt !== p.updatedAt)
      diff.editedComments.push({ kind: "review", id: c.id, user: c.user, bot: c.bot, path: c.path, line: c.line, body: c.body, link: c.htmlUrl, updatedAt: c.updatedAt });
  }

  diff.allTerminal = ciVisibility.available && !missingCurrentActions && diff.stillRunning.length === 0;
  // Surface ALL currently-failing checks (not just new ones) so a pre-existing
  // red — especially moon-ci — is reported on re-watch instead of "all green",
  // and so moon-ci can short-circuit an immediate return (see classify).
  diff.currentFailures = failingChecks.map((c) => ({
    name: c.name, workflow: c.workflowName, conclusion: c.conclusion, link: c.link,
  }));
  diff.moonCiFailing = failingChecks.some(isMoonCi);
  diff.heresyFailing = failingChecks.some(
    (c) => /heresy/i.test(c.name || "") || /heresy/i.test(c.workflowName || "")
  );
  diff.mergeConflict = pm.mergeable === "CONFLICTING";

  // Tag each NEW or EDITED comment/review with `wake`: is it worth waking the
  // parent for? Rules (see the noise policy in the agent prompt):
  //   - humans always wake;
  //   - review bots (Copilot, Cursor/Bugbot) wake on a NEW comment/review;
  //   - bot comment EDITS never wake (vercel/heresy/linear status churn);
  //   - status-bot NEW issue comments never wake (vercel [vc]:, linear linkback);
  //   - heresy sticky comment wakes ONLY when the Heresy Check is failing
  //     (content-aware: the edit carries the finding text; on all-clear it's noise).
  // newFailures always wake regardless (handled below, not via this flag).
  const wakeNew = (item) => commentWake(item, { heresyFailing: diff.heresyFailing });
  for (const r of diff.newReviews) r.wake = wakeNew(r);
  for (const c of diff.newIssueComments) c.wake = wakeNew(c);
  for (const c of diff.newReviewComments) c.wake = wakeNew(c);
  // Edited comments: a human editing their comment can wake; a bot edit never
  // does (the vercel/heresy/linear status-edit churn the parent kept relaunching on).
  for (const c of diff.editedComments)
    c.wake = !c.bot ? true : isHeresyComment(c) && diff.heresyFailing;

  diff.summary = {
    prStateChanges: diff.prStateChanges.length,
    newFailures: diff.newFailures.length,
    nowPassing: diff.nowPassing.length,
    stillRunning: diff.stillRunning.length,
    newChecks: diff.newChecks.length,
    newReviews: diff.newReviews.length,
    newIssueComments: diff.newIssueComments.length,
    newReviewComments: diff.newReviewComments.length,
    editedComments: diff.editedComments.length,
  };
  // Actionable = things the parent can/should act on now. A new commit push or
  // a check merely going pending->success is NOT actionable on its own; it is
  // reported when the run returns for another reason (e.g. CI settles).
  // Only WAKE-worthy comments/reviews count (humans + review bots + heresy
  // findings); bot status-churn edits do not (they caused the false re-launches).
  const wakeComments =
    diff.newIssueComments.filter((c) => c.wake).length +
    diff.newReviewComments.filter((c) => c.wake).length +
    diff.newReviews.filter((r) => r.wake).length +
    diff.editedComments.filter((c) => c.wake).length;
  diff.summary.actionable = diff.newFailures.length + wakeComments;
  // How many comments/reviews are present-but-not-wake-worthy (bot status
  // churn) so the agent can mention them in one muted line instead of listing them.
  diff.summary.botChurn =
    (diff.newIssueComments.length + diff.newReviewComments.length +
      diff.newReviews.length + diff.editedComments.length) - wakeComments;
  diff.summary.totalNew =
    diff.prStateChanges.length + diff.newFailures.length + diff.nowPassing.length +
    diff.stillRunning.length + diff.newChecks.length + diff.newReviews.length +
    diff.newIssueComments.length + diff.newReviewComments.length + diff.editedComments.length;

  return diff;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Decide whether a poll result should return to the parent.
// Returns a reason string or null to keep polling.
// Decide whether a poll result should return to the parent.
// Returns a reason string or null to keep polling.
// moon-ci is special: if it is red, return immediately even when other checks
// are still running and even if the failure is pre-existing (not "new"), so the
// parent can launch the moon-ci log distiller right away instead of waiting on
// the rest of CI.
function classify(res) {
  // Partial review visibility is useful, but it is not a working PR monitor.
  // Return immediately and loudly instead of silently retrying a deterministic
  // permissions failure until the poll deadline.
  if (res.ciVisibility?.available === false) return "ci-unavailable";
  if (res.firstWatch) {
    // A merge conflict is the cleanest first thing to surface on a fresh
    // watch: rebasing is cheap, fast, and often the root cause of red CI.
    if (res.mergeConflict) return "merge-conflict";
    if (res.moonCiFailing) return "moon-ci-failing";
    if (res.currentFailures && res.currentFailures.length) return "baseline-failing";
    // The Actions API can expose one fast workflow before the rest of the PR
    // workflows have registered. Require one more poll before declaring an
    // Actions-only baseline settled; failures still wake immediately above.
    if (res.allTerminal && res.ciVisibility?.source === "actions") return null;
    if (res.allTerminal) return "settled"; // nothing running and nothing failing
    return null; // CI still running, no failures yet — keep watching
  }
  // A merge conflict (new or pre-existing) short-circuits immediately —
  // rebasing unblocks everything downstream and is cheaper than waiting on CI.
  if (res.mergeConflict) return "merge-conflict";
  // moon-ci red always short-circuits, new or pre-existing.
  if (res.moonCiFailing) return "moon-ci-failing";
  if (res.summary.actionable > 0) return "actionable";
  if (res.allTerminal) {
    // CI finished. Distinguish green from "settled on a pre-existing failure"
    // so the parent never reads "all green" when something is actually red.
    return res.currentFailures && res.currentFailures.length ? "settled-failing" : "settled";
  }
  return null; // only stillRunning — keep watching
}

async function pollLoop(args) {
  const start = Date.now();
  let iterations = 0;
  let res = null;
  for (;;) {
    iterations++;
    try {
      res = buildResult(args);
    } catch (e) {
      // A transient gh failure mid-poll: if we are near the deadline, surface
      // it; otherwise sleep one interval and retry. Never loop faster than the
      // interval on errors.
      if (Date.now() - start >= args.deadlineMs) {
        emit({ error: "poll failed: " + e.message, poll: { reason: "error", iterations, elapsedMs: Date.now() - start } });
        return;
      }
      await sleep(args.intervalMs);
      continue;
    }

    const reason = classify(res);
    const elapsedMs = Date.now() - start;

    if (reason) {
      res.poll = {
        mode: "poll", reason, iterations, elapsedMs,
        elapsedMin: Math.round(elapsedMs / 60000),
        intervalMs: args.intervalMs, intervalSec: args.intervalMs / 1000,
        deadlineMs: args.deadlineMs, deadlineMin: Math.round(args.deadlineMs / 60000),
        stillRunning: (res.stillRunning || res.runningChecks || []).map((c) =>
          typeof c === "string" ? c : c.name
        ),
        allTerminal: !!res.allTerminal,
      };
      emit(res);
      return;
    }

    if (elapsedMs >= args.deadlineMs) {
      res.poll = {
        mode: "poll", reason: "deadline", iterations, elapsedMs,
        elapsedMin: Math.round(elapsedMs / 60000),
        intervalMs: args.intervalMs, intervalSec: args.intervalMs / 1000,
        deadlineMs: args.deadlineMs, deadlineMin: Math.round(args.deadlineMs / 60000),
        stillRunning: (res.stillRunning || res.runningChecks || []).map((c) =>
          typeof c === "string" ? c : c.name
        ),
        allTerminal: !!res.allTerminal,
      };
      emit(res);
      return;
    }

    await sleep(args.intervalMs);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.poll) {
    await pollLoop(args);
  } else {
    try {
      emit(buildResult(args));
    } catch (e) {
      fail(e.message);
    }
  }
}

// Node canonicalizes import.meta.url when the entrypoint is reached through a
// symlink, but process.argv[1] retains the literal symlink path. Compare real
// paths so a supported alternate path cannot silently turn execution into an
// import-only no-op.
function isMainModule(moduleUrl = import.meta.url, entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
  } catch {
    return moduleUrl === pathToFileURL(entryPath).href;
  }
}

// Exported for unit tests; only run main when executed directly.
export { parseArgs, buildResult, classify, pollLoop };

if (isMainModule()) {
  main().catch((e) => fail("unexpected error: " + e.message));
}
