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

export interface PrepareRepoInput {
  pat: string;
  repoFullName: string;
}

export interface PrepareRepoResult {
  baseBranch: string;
  baseSha: string;
}

/**
 * Pre-flight verification — runs BEFORE the expensive AI call.
 *
 * Confirms:
 *   - The PAT can read the repo (catches scope mistakes early).
 *   - There's a default-branch ref to fork feature branches from. If the
 *     repo is empty, an initial commit is created here so the AI step's
 *     output has somewhere to land.
 *
 * Throwing from this step costs the user $0 in Anthropic tokens — the
 * Inngest function explicitly orders this BEFORE call-agent for that
 * reason. Future repo-side bugs (expired PAT, deleted repo, etc.) fail
 * cheaply.
 */
export async function prepareTargetRepo(
  input: PrepareRepoInput,
): Promise<PrepareRepoResult> {
  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Invalid repoFullName "${input.repoFullName}" — expected "owner/repo"`,
    );
  }

  const octokit = new Octokit({ auth: input.pat });

  let baseBranch: string;
  try {
    const repoMeta = await octokit.repos.get({ owner, repo });
    baseBranch = repoMeta.data.default_branch;
  } catch (err) {
    throw enrichOctokitError(
      err,
      `Couldn't read repo "${input.repoFullName}". PAT scope ok?`,
    );
  }

  let baseSha: string;
  try {
    const baseRef = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });
    baseSha = baseRef.data.object.sha;
  } catch (err) {
    if (!isEmptyRepoError(err)) {
      throw enrichOctokitError(
        err,
        `Couldn't read default ref "heads/${baseBranch}" on "${input.repoFullName}"`,
      );
    }
    // Empty repo — seed an initial commit. Idempotent: subsequent runs
    // hit the success path above.
    baseSha = await bootstrapEmptyRepo(octokit, owner, repo, baseBranch);
  }

  return { baseBranch, baseSha };
}

export interface CommitInput {
  pat: string;
  repoFullName: string;
  baseBranch: string;
  baseSha: string;
  branchName: string;
  filePath: string;
  fileContent: string;
  commitMessage: string;
}

export interface CommitResult {
  branch: string;
  commitSha: string;
  fileSha: string;
}

/**
 * Creates the feature branch from the prepared baseSha, then commits the
 * file. Runs AFTER the AI step — assumes prepareTargetRepo already
 * validated the PAT + made sure the repo has at least one commit.
 *
 * If the file already exists on the default branch (e.g. a previous
 * generation lives there), its blob SHA is read first so the new
 * branch's commit is an *update* rather than a 422 "file already exists".
 */
export async function commitGeneratedFile(
  input: CommitInput,
): Promise<CommitResult> {
  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Invalid repoFullName "${input.repoFullName}" — expected "owner/repo"`,
    );
  }

  const octokit = new Octokit({ auth: input.pat });

  let existingFileSha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({
      owner,
      repo,
      path: input.filePath,
      ref: input.baseBranch,
    });
    if (!Array.isArray(existing.data) && "sha" in existing.data) {
      existingFileSha = existing.data.sha;
    }
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw enrichOctokitError(
        err,
        `Couldn't read ${input.filePath} on ${input.baseBranch}`,
      );
    }
  }

  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${input.branchName}`,
      sha: input.baseSha,
    });
  } catch (err) {
    throw enrichOctokitError(
      err,
      `Couldn't create branch "${input.branchName}" from ${input.baseBranch}`,
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
 * something to base off.
 *
 * NOTE: my first attempt used the Git Data API (createBlob → createTree
 * → createCommit → createRef). It returned "Git Repository is empty" on
 * createBlob — GitHub's Git Data API has an undocumented restriction
 * against writing to a fully-empty repo. The Contents API
 * (createOrUpdateFileContents) handles the "no commits yet" case
 * atomically, including initializing the default-branch ref. So we use
 * that instead, even though it's a coarser-grained primitive.
 *
 * Returns the SHA of the new bootstrap commit (now the head of the
 * default branch). Idempotent against subsequent runs because the next
 * generation finds a populated ref and skips this branch entirely.
 */
async function bootstrapEmptyRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  defaultBranch: string,
): Promise<string> {
  const readmeContent = `# ${repo}\n\nThis repository is managed by Jab. Generated Next.js code is pushed to feature branches.\n`;
  const result = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: "README.md",
    message: "Initial commit (Jab bootstrap)",
    content: Buffer.from(readmeContent, "utf8").toString("base64"),
    branch: defaultBranch,
  });
  if (!result.data.commit.sha) {
    throw new Error("Bootstrap commit succeeded but no SHA was returned");
  }
  return result.data.commit.sha;
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    return (err as { status: number }).status === 404;
  }
  return false;
}

/**
 * Detects the specific "repo has zero commits" response. GitHub returns
 * HTTP 409 Conflict with "Git Repository is empty." (with that period
 * and casing) when you ask for any ref on a brand-new repo. Match the
 * message specifically — don't generalize to all 409s, since other 409s
 * (e.g. "Reference already exists") have different remediation.
 */
function isEmptyRepoError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    const e = err as { status: number; message?: string };
    return e.status === 409 && /git repository is empty/i.test(e.message ?? "");
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
