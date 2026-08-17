// Pure parsing logic for git's pre-push hook stdin protocol: one line per
// ref being pushed, `<local ref> SP <local sha1> SP <remote ref> SP
// <remote sha1>`. Extracted so ai-code-review-precheck.mjs's ref-selection
// logic is independently testable — see pre-push-refs.test.mjs. No I/O in
// this file.
//
// Exists specifically because an AI review round on this script's
// introducing PR caught that the first version ignored stdin entirely and
// always diffed local HEAD — silently reviewing (and gating on) a
// completely different diff than whatever was actually being pushed
// whenever the pushed ref wasn't the checked-out branch (e.g. `git push
// origin fix:main`, a tag push, or a multi-ref push). See CLAUDE.md's
// "Local pre-push AI review precheck" section for the full finding.

const ZERO_SHA = "0".repeat(40);

// Returns { sha, localRef, remoteRef } for the single commit to review, or
// { skip: reason } when there's nothing to review (delete-only push) or
// more than one non-delete ref is being pushed at once. Declining is
// deliberate: reviewing the wrong one silently (or picking one arbitrarily)
// would produce a verdict that looks authoritative but isn't actually about
// what's being pushed — same "unclear or malformed input fails open with a
// warning" philosophy as the rest of this script, not an attempt to guess
// the "right" ref.
//
// sha always comes from localSha — that's the actual code content being
// pushed, regardless of what remote branch name it lands on. But which PR
// (if any) this update belongs to is a question about the REMOTE branch,
// not the local one: `gh pr view <name>` resolves <name> against remote
// head branches on GitHub, and a local branch's own name has no PR
// identity at all unless a same-named remote branch happens to exist. Two
// AI review rounds landed on this in sequence: the first caught that
// override context was being fetched for gh's checked-out-branch default
// instead of any pushed ref at all; the second then caught that even
// keying off localRef (not remoteRef) is wrong for a renamed push like
// `git push origin fix-branch:main` — the relevant PR (if any) is main's,
// not whatever PR (if any) happens to share the name "fix-branch". Both
// localRef and remoteRef are returned so callers can use the right one for
// the right purpose (localRef for git operations against the local repo,
// remoteRef for anything that has to match GitHub's own view of the push).
export function selectPushedCommit(stdinText) {
  const lines = (stdinText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const refs = lines.map((line) => {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    return { localRef, localSha, remoteRef, remoteSha };
  });

  const nonDelete = refs.filter((r) => r.localSha && r.localSha !== ZERO_SHA);

  if (nonDelete.length === 0) {
    return { skip: "no non-delete refs being pushed (empty or delete-only push)" };
  }
  if (nonDelete.length > 1) {
    return {
      skip: `${nonDelete.length} refs pushed at once — reviewing more than one ref per push isn't supported yet`,
    };
  }
  return {
    sha: nonDelete[0].localSha,
    localRef: nonDelete[0].localRef,
    remoteRef: nonDelete[0].remoteRef,
  };
}

// A pushed ref might not be a branch at all (a tag push, e.g.
// `refs/tags/v1.0`) — there's no PR/override-log concept for that, so
// callers should treat a null return as "don't try to fetch override
// context, there's nothing to map it to" rather than an error. Works on
// either localRef or remoteRef — it's a plain refs/heads/ prefix strip,
// agnostic to which one the caller passes.
export function branchNameFromRef(ref) {
  const prefix = "refs/heads/";
  return typeof ref === "string" && ref.startsWith(prefix)
    ? ref.slice(prefix.length)
    : null;
}
