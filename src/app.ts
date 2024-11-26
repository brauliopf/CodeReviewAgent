import { Octokit } from "@octokit/rest";
import { createNodeMiddleware } from "@octokit/webhooks"; // verify authenticity of webhook event
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema"; // interface for webhook event (types)
import * as http from "http";
import { App } from "octokit"; // github sdk
import { Review } from "./constants";
import { env } from "./env";
import { filterFile, processPullRequest } from "./review-agent";
import { applyReview } from "./reviews";
import { listAllFiles } from "./github";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pinecone } from "@pinecone-database/pinecone";

// This creates a new instance of the Octokit App class.
const reviewApp = new App({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_PRIVATE_KEY,
  webhooks: {
    secret: env.GITHUB_WEBHOOK_SECRET,
  },
});

/**
 * Get the edited files in the PR
 * @param payload - the payload of the webhook event
 * @returns the list of files edited in the PR ("ignorable" or not)
 */
const getEditedfiles = async (payload: WebhookEventMap["pull_request"]) => {
  try {
    // installation refers to the repository that installed the app
    // get the sdk to interact with the github api for that installation
    const octokit = await reviewApp.getInstallationOctokit(
      payload.installation.id
    );
    // lists the files in a specified pull request.
    // https://octokit.github.io/rest.js/v21/#pulls-list-files
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pull_number: payload.pull_request.number,
    });

    return files;
  } catch (exc) {
    console.log("exc");
    return [];
  }
};

// This adds an event handler that your code will call later. When this event handler is called, it will log the event to the console. Then, it will use GitHub's REST API to add a comment to the pull request that triggered the event.
async function handlePullRequestOpened({
  octokit,
  payload,
}: {
  octokit: Octokit;
  payload: WebhookEventMap["pull_request"];
}) {
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
    const files = await getEditedfiles(payload);
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
}

/**
 * Handle the event when a repository is added to the installation.
 * Assumes main branch is called "main"
 */
async function handleRepositoriesAdded({
  octokit,
  payload,
}: {
  octokit: Octokit;
  payload: WebhookEventMap["installation_repositories"];
}) {
  console.log(
    "@handleInstallationRepositoriesAdded installation_repositories.added"
  );

  // Get filepaths
  let filepaths: { [key: string]: string[] } = {};
  for (const repo of payload.repositories_added) {
    let temp_filepaths: string[] = [];
    const owner = payload.installation.account.login;
    const repoName = repo.name;
    const branch = "main";
    temp_filepaths = await listAllFiles({
      octokit,
      owner,
      repository: repoName,
      branch,
    });

    // Filter out ignorable files
    filepaths[repoName] = temp_filepaths.filter(filterFile);

    // Embed repository
    const genAI = new GoogleGenerativeAI(env.GOOGLE_AI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "text-embedding-004",
    });

    const getEmbeddings = async (content: string) => {
      const result = await model.embedContent(content);
      return result.embedding;
    };

    // Instantiate pinecone
    const pc = new Pinecone({
      apiKey: env.PINECONE_API_KEY,
    });

    // Access files
    try {
      for (const filepath of filepaths[repoName]) {
        const fileContent = await octokit.rest.repos.getContent({
          owner,
          repo: repoName,
          path: filepath,
        });

        // Decode file content from base64 to utf-8
        let decodedContent: string;
        // Check if the response is an array or a single object
        if (Array.isArray(fileContent.data)) {
          throw new Error("Expected a single file, but received multiple.");
        } else if (
          fileContent.data.type === "file" &&
          fileContent.status === 200
        ) {
          const content = fileContent.data.content;
          decodedContent = Buffer.from(content, "base64").toString("utf-8");
        } else {
          throw new Error(
            `Failed to get file content. File is not of type 'file' or status is not 200`
          );
        }

        // Get embeddings
        const embeddings = await getEmbeddings(decodedContent);

        // Create a serverless index
        const indexName = "pr-reviewer-index";

        const checkIndexExists = async (indexName: string) => {
          try {
            await pc.describeIndex(indexName);
            return true; // Index exists
          } catch (error) {
            if (error.message.includes("Index not found")) {
              return false; // Index does not exist
            } else {
              console.log("Index not found. Likely, it does not exist");
            }
          }
        };

        const indexExists = await checkIndexExists(indexName);

        if (!indexExists) {
          await pc.createIndex({
            name: indexName,
            dimension: 768,
            metric: "cosine",
            spec: {
              serverless: {
                cloud: "aws",
                region: "us-east-1",
              },
            },
          });
        }

        // Target the index where you'll store the vector embeddings
        const index = pc.index(indexName);

        // Each contains an 'id', the embedding 'values', and the original text as 'metadata'
        const records = [
          {
            id: filepath,
            values: embeddings.values,
            metadata: { repo: repoName },
          },
        ];

        // Upsert the vectors into the index
        await index.namespace("the-example-namespace").upsert(records);

        console.log("Upserted", filepath, "to", indexName);
      }
      console.log("Done with all files in", repoName);
    } catch (exc) {
      console.log("Failed to decode file and getEmbeddings", exc);
    }
  }
}

// Sets up a webhook event listener
// When your app receives a webhook event from GitHub, check the header value for the `X-GitHub-Event`:
//@ts-ignore
reviewApp.webhooks.on("pull_request.opened", handlePullRequestOpened);
reviewApp.webhooks.on(
  "installation_repositories.added",
  //@ts-ignore
  handleRepositoriesAdded
);

// Middleware to log every webhook event
// Runs after the specific webhook events
//@ts-ignore
// reviewApp.webhooks.onAny((payload) => {});

const port = process.env.PORT || 3000;
const reviewWebhook = `/api/review`;

const reviewMiddleware = createNodeMiddleware(reviewApp.webhooks, {
  path: "/api/review",
});

const server = http.createServer((req, res) => {
  if (req.url === reviewWebhook) {
    reviewMiddleware(req, res);
  } else {
    res.statusCode = 404;
    res.end();
  }
});

// This creates a Node.js server that listens for incoming HTTP requests (including webhook payloads from GitHub) on the specified port. When the server receives a request, it executes the `middleware` function that you defined earlier. Once the server is running, it logs messages to the console to indicate that it is listening.
server.listen(port, () => {
  console.log(`Server is listening for events on port ${port}.`);
  console.log("Press Ctrl + C to quit.");
});
