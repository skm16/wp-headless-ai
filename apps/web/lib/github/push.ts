import "server-only";
import { Octokit } from "@octokit/rest";

/**
 * Push a generated file onto a fresh feature branch in the agency's repo.
 *
 * Flow:
 *   1. Resolve the repo's default branch + its current head commit SHA.
 *   2. If the target file already exists on the default branch, capture
 *      its blob SHA so we can update-in-place (vs. erroring with 422).
 *   3. Create a new ref (`refs/heads/jab/<page>-<jobshort>`) pointing at
 *      the default-branch head.
 *   4. PUT the file via the Contents API on the new ref. Git Data API
 *      would let us batch into one commit, but Contents API is ~2 fewer
 *      calls and simpler — for a single file v0 doesn't need batching.
 *
 * Repo prerequisite: NOT empty. There must be at least one commit on the
 * default branch (a single README counts). The Phase C wizard documents
 * this in the GitHub form hint. If you hit a 409 or empty-repo error,
 * push the README first, then retry the generation.
 */

export interface PushInput {
  pat: string;
  repoFullName: string; // "owner/repo"
  branchName: string;
  filePath: string;
  fileContent: string;
  commitMessage: string;
}

export interface PushResult {
  branch: string;
  commitSha: string;
  fileSha: string;
}

export async function pushGeneratedFile(input: PushInput): Promise<PushResult> {
  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Invalid repoFullName "${input.repoFullName}" — expected "owner/repo"`,
    );
  }

  const octokit = new Octokit({ auth: input.pat });

  let baseBranch: string;
  let baseSha: string;
  try {
    const repoMeta = await octokit.repos.get({ owner, repo });
    baseBranch = repoMeta.data.default_branch;
    try {
      const baseRef = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`,
      });
      baseSha = baseRef.data.object.sha;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      // Empty repo — bootstrap an initial commit so the feature-branch
      // flow below has a base to fork from. Idempotent: the next
      // generation finds the ref now exists and skips this branch.
      baseSha = await bootstrapEmptyRepo(octokit, owner, repo, baseBranch);
    }
  } catch (err) {
    throw enrichOctokitError(
      err,
      `Couldn't read repo "${input.repoFullName}". PAT scope ok?`,
    );
  }

  // Existing file SHA — needed to update vs. create. 404 is the expected
  // "first time we've ever generated this path" case; bubble anything else.
  let existingFileSha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo,
      path: input.filePath,
      ref: baseBranch,
    });
    if (!Array.isArray(existing.data) && "sha" in existing.data) {
      existingFileSha = existing.data.sha;
    }
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw enrichOctokitError(err, `Couldn't read ${input.filePath} on ${baseBranch}`);
    }
  }

  // Create the feature branch. If a branch with the same name already
  // exists (rare — names include the jobId fragment), surface the error
  // verbatim rather than silently overwrite.
  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${input.branchName}`,
      sha: baseSha,
    });
  } catch (err) {
    throw enrichOctokitError(
      err,
      `Couldn't create branch "${input.branchName}" from ${baseBranch}`,
    );
  }

  let commitSha = "";
  let fileSha = "";
  try {
    const put = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: input.filePath,
      message: input.commitMessage,
      content: Buffer.from(input.fileContent, "utf8").toString("base64"),
      branch: input.branchName,
      ...(existingFileSha ? { sha: existingFileSha } : {}),
    });
    commitSha = put.data.commit.sha ?? "";
    fileSha = put.data.content?.sha ?? "";
  } catch (err) {
    throw enrichOctokitError(
      err,
      `Couldn't push ${input.filePath} to ${input.branchName}`,
    );
  }

  return {
    branch: input.branchName,
    commitSha,
    fileSha,
  };
}

/**
 * Build a deterministic feature-branch name from a page path + job id.
 *   "/"          + "abc12345…" → "jab/home-abc12345"
 *   "/about"     + "abc12345…" → "jab/about-abc12345"
 *   "/team/lead" + "abc12345…" → "jab/team-lead-abc12345"
 */
export function generationBranchName(pagePath: string, jobId: string): string {
  const slug =
    pagePath === "/" || pagePath === ""
      ? "home"
      : pagePath
          .replace(/^\/+|\/+$/g, "")
          .replace(/[^a-z0-9]+/gi, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase() || "home";
  return `jab/${slug}-${jobId.slice(0, 8)}`;
}

/**
 * Seed an empty repo with a first commit so feature-branch creation has
 * something to base off. Uses the Git Data API directly because the
 * Contents API's "create branch if missing" magic only works on repos
 * that already have at least one commit.
 *
 * Returns the SHA of the new bootstrap commit (which is now the head of
 * the default branch).
 */
async function bootstrapEmptyRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<string> {
  const readmeContent = `# ${repo}\n\nThis repository is managed by Jab. Generated Next.js code is pushed to feature branches.\n`;
  const blob = await octokit.git.createBlob({
    owner,
    repo,
    content: Buffer.from(readmeContent, "utf8").toString("base64"),
    encoding: "base64",
  });
  const tree = await octokit.git.createTree({
    owner,
    repo,
    tree: [
      {
        path: "README.md",
        mode: "100644",
        type: "blob",
        sha: blob.data.sha,
      },
    ],
  });
  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message: "Initial commit (Jab bootstrap)",
    tree: tree.data.sha,
    parents: [],
  });
  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${defaultBranch}`,
    sha: commit.data.sha,
  });
  return commit.data.sha;
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    return (err as { status: number }).status === 404;
  }
  return false;
}

function enrichOctokitError(err: unknown, prefix: string): Error {
  if (typeof err === "object" && err !== null && "status" in err) {
    const e = err as { status: number; message?: string };
    return new Error(`${prefix}: HTTP ${e.status} ${e.message ?? ""}`.trim());
  }
  if (err instanceof Error) {
    return new Error(`${prefix}: ${err.message}`);
  }
  return new Error(`${prefix}: ${String(err)}`);
}
