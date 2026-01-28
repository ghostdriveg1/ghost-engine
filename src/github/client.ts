import { Octokit } from '@octokit/rest';

/**
 * Creates a configured Octokit client for GitHub API operations.
 * 
 * @param token - GitHub Personal Access Token
 * @returns Configured Octokit instance
 * 
 * @example
 * const octokit = createGitHubClient(process.env.GITHUB_TOKEN);
 */
export function createGitHubClient(token: string): Octokit {
    return new Octokit({
        auth: token,
    });
}

/**
 * Fetches file content and SHA from GitHub repository.
 * Used for optimistic locking in index updates.
 * 
 * @param octokit - Configured Octokit instance
 * @param owner - Repository owner (GitHub username or org)
 * @param repo - Repository name
 * @param path - File path within repository
 * @returns Object containing base64-decoded content and SHA
 * @throws Error if path is not a file or doesn't exist
 * 
 * @example
 * const { content, sha } = await fetchFile(octokit, 'user', 'repo', 'db.json');
 */
export async function fetchFile(
    octokit: Octokit,
    owner: string,
    repo: string,
    path: string
): Promise<{ content: string; sha: string }> {
    const response = await octokit.repos.getContent({
        owner,
        repo,
        path,
    });

    if (Array.isArray(response.data) || response.data.type !== 'file') {
        throw new Error(`Path ${path} is not a file`);
    }

    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');

    return {
        content,
        sha: response.data.sha,
    };
}
