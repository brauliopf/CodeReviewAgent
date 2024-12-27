import { Octokit } from "@octokit/rest";
import { createNodeMiddleware } from "@octokit/webhooks";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import * as http from "http";
import { App } from "octokit";
import { Review } from "./constants";
import { env } from "./env";
import { processPullRequest } from "./review-agent";
import { applyReview } from "./reviews";

// This creates a new instance of the Octokit App class.
const reviewApp = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhooks: {
    secret: env.GITHUB_WEBHOOK_SECRET,
  },
});

const listUpsertedFiles = async (payload: WebhookEventMap["pull_request"]) => {
  try {
    console.trace();
    console.log("----/n- ", "listUpsertedFiles", typeof payload);
    const octokit = await reviewApp.getInstallationOctokit(
      payload.installation.id
    );
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: payload.pull_request.number,
    });
    console.dir({ files }, { depth: null });
    return files;
  } catch (exc) {
    console.log("exc");
    return [];
  }
};

// Create function to handle incoming PR updates --event handler: Log the event + Add a comment to the PR using GitHub's REST API
const handlePullRequestOpened = async ({
  octokit,
  payload,
}: {
  octokit: Octokit;
  payload: WebhookEventMap["pull_request"];
}) => {
  console.log(
    `Received a pull request event for #${payload.pull_request.number}`
  );
  // const reposWithInlineEnabled = new Set<number>([601904706, 701925328]);
  // const canInlineSuggest = reposWithInlineEnabled.has(payload.repository.id);
  try {
    console.log("pr info", {
      id: payload.repository.id,
      fullName: payload.repository.full_name,
      url: payload.repository.html_url,
    });
    const files = await listUpsertedFiles(payload);
    const review: Review = await processPullRequest(
      octokit,
      payload,
      files,
      true
    );
    await applyReview({ octokit, payload, review });
    console.log("Review Submitted");
  } catch (exc) {
    console.log(exc);
  }
};

// This sets up a webhook event listener (callback function) --When app receives a webhook event from GitHub with a `X-GitHub-Event` header value of `pull_request` and an `action` payload value of `opened`, it calls the `handlePullRequestOpened` event handler.
//@ts-ignore
reviewApp.webhooks.on("pull_request.opened", handlePullRequestOpened);

const port = process.env.PORT || 3000;
const reviewWebhook = `/api/review`;

const reviewMiddleware = createNodeMiddleware(reviewApp.webhooks, {
  path: reviewWebhook,
});

const server = http.createServer((req, res) => {
  if (req.url === reviewWebhook) {
    reviewMiddleware(req, res);
  } else {
    res.statusCode = 404;
    res.end();
  }
});

/**
 * This creates a Node.js server that listens for incoming HTTP requests (including webhook payloads from GitHub).
 * For each incoming request, the server executes a `middleware` function from the Octokit module, that can retrieve the webhook event requests from GitHub and accept redirects from the OAuth user web flow.
 * Once the server is running, it logs messages to the console to indicate that it is listening.
 */
server.listen(port, () => {
  console.log(`Server is listening for events.`);
  console.log("Press Ctrl + C to quit.");
});
