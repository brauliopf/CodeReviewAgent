import { Octokit } from "@octokit/rest";

/**
 * List all files in a repository. Query the git tree associated to the last commit and traverses it recursively, using
 * `recursive: "true"`.
 */
export const listAllFiles = async ({
  octokit,
  owner,
  repository,
  branch,
}: {
  octokit: Octokit;
  owner: string;
  repository: string;
  branch: string;
}) => {
  try {
    console.log("Getting the SHA of the latest commit on the specified branch");
    console.log(
      "brauliopf",
      `owner: ${owner}, repository: ${repository}, branch: ${branch}, octokit: ${octokit.auth}`
    );

    // Get the SHA of the latest commit on the specified branch
    const { data: refData } = await octokit.rest.git.getRef({
      owner,
      repo: repository,
      ref: `heads/${branch}`,
    });
    const commitSha = refData.object.sha;

    // Get the tree associated with the latest commit
    const { data: commitData } = await octokit.rest.git.getCommit({
      owner,
      repo: repository,
      commit_sha: commitSha,
    });
    const treeSha = commitData.tree.sha;

    // Get the full tree recursively
    const { data: treeData } = await octokit.rest.git.getTree({
      owner,
      repo: repository,
      tree_sha: treeSha,
      recursive: "true",
    });

    // Extract and print file paths
    const filePaths = treeData.tree
      .filter((item: any) => item.type === "blob")
      .map((item: any) => item.path);

    return filePaths;
  } catch (error) {
    console.error(`Error fetching file paths: ${error.message}`);
  }
};
