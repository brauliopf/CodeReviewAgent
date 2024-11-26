import { Octokit } from "@octokit/rest";
import { WebhookEventMap } from "@octokit/webhooks-definitions/schema";
import { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import * as xml2js from "xml2js";
import type {
  BranchDetails,
  BuilderResponse,
  Builders,
  CodeSuggestion,
  PRFile,
  PRSuggestion,
} from "./constants";
import { PRSuggestionImpl } from "./data/PRSuggestionImpl";
import { generateChatCompletion } from "./llms/chat";
import {
  PR_SUGGESTION_TEMPLATE,
  buildPatchPrompt,
  constructPrompt,
  getReviewPrompt,
  getTokenLength,
  getXMLReviewPrompt,
  isConversationWithinLimit,
} from "./prompts";
import {
  INLINE_FIX_FUNCTION,
  getInlineFixPrompt,
} from "./prompts/inline-prompt";
import { getGitFile } from "./reviews";

export const reviewDiff = async (messages: ChatCompletionMessageParam[]) => {
  const message = await generateChatCompletion({
    messages,
  });
  return message.content;
};

export const reviewFiles = async (
  files: PRFile[],
  patchBuilder: (file: PRFile) => string,
  convoBuilder: (diff: string) => ChatCompletionMessageParam[]
) => {
  const patches = files.map((file) => patchBuilder(file));
  const messages = convoBuilder(patches.join("\n"));
  const feedback = await reviewDiff(messages);
  return feedback;
};

export const filterFile = (filepath: String) => {
  const extensionsToIgnore = new Set<string>([
    "pdf",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "mp4",
    "mp3",
    "md",
    "json",
    "env",
    "toml",
    "svg",
  ]);
  const filesToIgnore = new Set<string>([
    "package-lock.json",
    "yarn.lock",
    ".gitignore",
    "package.json",
    "tsconfig.json",
    "poetry.lock",
    "readme.md",
  ]);

  // Check black-lists and provide feedback
  // 1. Check if file is in ignore list
  const filename = filepath.toLowerCase().split("/").pop();
  if (filename && filesToIgnore.has(filename)) {
    console.log(`Filtering out ignored file: ${filename}`);
    return false;
  }
  // 2. Check if file has no extension
  const splitFilename = filename.toLowerCase().split(".");
  if (splitFilename.length <= 1) {
    console.log(`Filtering out file with no extension: ${filename}`);
    return false;
  }
  // 3. Check if file has ignored extension
  const extension = splitFilename.pop()?.toLowerCase();
  if (extension && extensionsToIgnore.has(extension)) {
    console.log(
      `Filtering out file with ignored extension: ${filename} (.${extension})`
    );
    return false;
  }
  return true;
};

/**
 * Filter out files that are not relevant to the review: review extension, ignored files, etc
 * @param file - PRFile: the file to filter
 * @returns a boolean
 */
const filterPRFile = (file: PRFile) => {
  return filterFile(file.filename);
};

const groupFilesByExtension = (files: PRFile[]): Map<string, PRFile[]> => {
  const filesByExtension: Map<string, PRFile[]> = new Map();

  files.forEach((file) => {
    const extension = file.filename.split(".").pop()?.toLowerCase();
    if (extension) {
      if (!filesByExtension.has(extension)) {
        filesByExtension.set(extension, []);
      }
      filesByExtension.get(extension)?.push(file);
    }
  });

  return filesByExtension;
};

// all of the files here can be processed with the prompt at minimum
const processWithinLimitFiles = (
  files: PRFile[],
  patchBuilder: (file: PRFile) => string,
  convoBuilder: (diff: string) => ChatCompletionMessageParam[]
) => {
  const processGroups: PRFile[][] = [];
  const convoWithinModelLimit = isConversationWithinLimit(
    constructPrompt(files, patchBuilder, convoBuilder)
  );

  console.log(`Within model token limits: ${convoWithinModelLimit}`);
  if (!convoWithinModelLimit) {
    const grouped = groupFilesByExtension(files);
    for (const [extension, filesForExt] of grouped.entries()) {
      const extGroupWithinModelLimit = isConversationWithinLimit(
        constructPrompt(filesForExt, patchBuilder, convoBuilder)
      );
      if (extGroupWithinModelLimit) {
        processGroups.push(filesForExt);
      } else {
        // extension group exceeds model limit
        console.log(
          "Processing files per extension that exceed model limit ..."
        );
        let currentGroup: PRFile[] = [];
        filesForExt.sort((a, b) => a.patchTokenLength - b.patchTokenLength);
        filesForExt.forEach((file) => {
          const isPotentialGroupWithinLimit = isConversationWithinLimit(
            constructPrompt([...currentGroup, file], patchBuilder, convoBuilder)
          );
          if (isPotentialGroupWithinLimit) {
            currentGroup.push(file);
          } else {
            processGroups.push(currentGroup);
            currentGroup = [file];
          }
        });
        if (currentGroup.length > 0) {
          processGroups.push(currentGroup);
        }
      }
    }
  } else {
    processGroups.push(files);
  }
  return processGroups;
};

const stripRemovedLines = (originalFile: PRFile) => {
  // remove lines starting with a '-'
  const originalPatch = String.raw`${originalFile.patch}`;
  const strippedPatch = originalPatch
    .split("\n")
    .filter((line) => !line.startsWith("-"))
    .join("\n");
  return { ...originalFile, patch: strippedPatch };
};

const processOutsideLimitFiles = (
  files: PRFile[],
  patchBuilder: (file: PRFile) => string,
  convoBuilder: (diff: string) => ChatCompletionMessageParam[]
) => {
  const processGroups: PRFile[][] = [];
  if (files.length == 0) {
    return processGroups;
  }
  files = files.map((file) => stripRemovedLines(file));
  const convoWithinModelLimit = isConversationWithinLimit(
    constructPrompt(files, patchBuilder, convoBuilder)
  );
  if (convoWithinModelLimit) {
    processGroups.push(files);
  } else {
    const exceedingLimits: PRFile[] = [];
    const withinLimits: PRFile[] = [];
    files.forEach((file) => {
      const isFileConvoWithinLimits = isConversationWithinLimit(
        constructPrompt([file], patchBuilder, convoBuilder)
      );
      if (isFileConvoWithinLimits) {
        withinLimits.push(file);
      } else {
        exceedingLimits.push(file);
      }
    });
    const withinLimitsGroup = processWithinLimitFiles(
      withinLimits,
      patchBuilder,
      convoBuilder
    );
    withinLimitsGroup.forEach((group) => {
      processGroups.push(group);
    });
    if (exceedingLimits.length > 0) {
      console.log("TODO: Need to further chunk large file changes.");
      // throw "Unimplemented"
    }
  }
  return processGroups;
};

/**
 * Parses the feedbacks into an array of objects that implements PRSuggestion, and adds a <![CDATA[XXX]]> tag around the code block, to escape the code block from XML parser.
 * @param feedbacks - string[]: the feedbacks from the review
 * @returns an array of PRSuggestion objects
 */
const processXMLSuggestions = async (feedbacks: string[]) => {
  const xmlParser = new xml2js.Parser();
  const parsedSuggestions = await Promise.all(
    feedbacks.map((fb) => {
      fb = fb
        .split("<code>")
        .join("<code><![CDATA[")
        .split("</code>")
        .join("]]></code>");
      return xmlParser.parseStringPromise(fb);
    })
  );
  // builds the suggestion arrays [[suggestion], [suggestion]], then flattens it once
  const allSuggestions = parsedSuggestions
    .map((sug) => sug.review.suggestion)
    .flat(1);

  const suggestions: PRSuggestion[] = allSuggestions.map((rawSuggestion) => {
    const lines = rawSuggestion.code[0].trim().split("\n");
    lines[0] = lines[0].trim();
    lines[lines.length - 1] = lines[lines.length - 1].trim();
    const code = lines.join("\n");

    return new PRSuggestionImpl(
      rawSuggestion.describe[0],
      rawSuggestion.type[0],
      rawSuggestion.comment[0],
      code,
      rawSuggestion.filename[0]
    );
  });
  return suggestions;
};

const generateGithubIssueUrl = (
  owner: string,
  repoName: string,
  title: string,
  body: string,
  codeblock?: string
) => {
  const encodedTitle = encodeURIComponent(title);
  const encodedBody = encodeURIComponent(body);
  const encodedCodeBlock = codeblock
    ? encodeURIComponent(`\n${codeblock}\n`)
    : "";

  let url = `https://github.com/${owner}/${repoName}/issues/new?title=${encodedTitle}&body=${encodedBody}${encodedCodeBlock}`;

  if (url.length > 2048) {
    url = `https://github.com/${owner}/${repoName}/issues/new?title=${encodedTitle}&body=${encodedBody}`;
  }
  return `[Create Issue](${url})`;
};

export const dedupSuggestions = (
  suggestions: PRSuggestion[]
): PRSuggestion[] => {
  const suggestionsMap = new Map<string, PRSuggestion>();
  suggestions.forEach((suggestion) => {
    suggestionsMap.set(suggestion.identity(), suggestion);
  });
  return Array.from(suggestionsMap.values());
};

/**
 * Organizes PR suggestions by filename and formats them into a structured comment in a pull request review, complete with links to create GitHub issues for each suggestion.
 * @param owner - string: the owner of the repository
 * @param repo - string: the name of the repository
 * @param suggestions - PRSuggestion[]: the suggestions to convert
 * @returns an array of strings, each representing a comment on a pull request
 */
const convertPRSuggestionToComment = (
  owner: string,
  repo: string,
  suggestions: PRSuggestion[]
): string[] => {
  const suggestionsMap = new Map<string, PRSuggestion[]>();
  suggestions.forEach((suggestion) => {
    if (!suggestionsMap.has(suggestion.filename)) {
      suggestionsMap.set(suggestion.filename, []);
    }
    suggestionsMap.get(suggestion.filename).push(suggestion);
  });
  const comments: string[] = [];
  for (let [filename, suggestions] of suggestionsMap) {
    const temp = [`## ${filename}\n`];
    suggestions.forEach((suggestion: PRSuggestion) => {
      const issueLink = generateGithubIssueUrl(
        owner,
        repo,
        suggestion.describe,
        suggestion.comment,
        suggestion.code
      );
      temp.push(
        PR_SUGGESTION_TEMPLATE.replace("{COMMENT}", suggestion.comment)
          .replace("{CODE}", suggestion.code)
          .replace("{ISSUE_LINK}", issueLink)
      );
    });
    comments.push(temp.join("\n"));
  }
  return comments;
};

/**
 * Constructs an XML response for a pull request review
 * @param owner - string: the owner of the repository
 * @param repoName - string: the name of the repository
 * @param feedbacks - string[]: the feedbacks from the review
 * @returns a BuilderResponse
 */
const xmlResponseBuilder = async (
  owner: string,
  repoName: string,
  feedbacks: string[]
): Promise<BuilderResponse> => {
  console.log("IN XML RESPONSE BUILDER");
  const parsedXMLSuggestions = await processXMLSuggestions(feedbacks);
  const comments = convertPRSuggestionToComment(
    owner,
    repoName,
    dedupSuggestions(parsedXMLSuggestions)
  );
  const commentBlob = comments.join("\n");
  return { comment: commentBlob, structuredComments: parsedXMLSuggestions };
};

/**
 * Higher-order function. Curried function to build the XML response from feedbacks with variable owner and repoName
 * @param owner - string: the owner of the repository
 * @param repoName - the name of the repository
 * @returns a function that takes in feedbacks and returns a BuilderResponse
 */
const curriedXmlResponseBuilder = (owner: string, repoName: string) => {
  return (feedbacks: string[]) =>
    xmlResponseBuilder(owner, repoName, feedbacks);
};

const basicResponseBuilder = async (
  feedbacks: string[]
): Promise<BuilderResponse> => {
  console.log("IN BASIC RESPONSE BUILDER");
  const commentBlob = feedbacks.join("\n");
  return { comment: commentBlob, structuredComments: [] };
};

export const reviewChanges = async (
  files: PRFile[],
  convoBuilder: (diff: string) => ChatCompletionMessageParam[],
  responseBuilder: (responses: string[]) => Promise<BuilderResponse>
) => {
  // get diffs for each file (patch file)
  // # "patch" here refers to the diff of the PR (old vs new)
  // # "buildPatchPrompt" outputs the patch piece to be used in the prompt.
  // # --defines the context strategy for the generative task
  const patchBuilder = buildPatchPrompt;
  const filteredFiles = files.filter((file) => filterPRFile(file));
  // add token length metadata to each file
  filteredFiles.map((file) => {
    file.patchTokenLength = getTokenLength(patchBuilder(file));
  });

  // further subdivide if necessary, maybe group files by common extension?
  const patchesWithinModelLimit: PRFile[] = [];
  // these single file patches are larger than the full model context
  const patchesOutsideModelLimit: PRFile[] = [];

  // check if patch + prompt is within the model limit and add to the appropriate list
  filteredFiles.forEach((file) => {
    const patchWithPromptWithinLimit = isConversationWithinLimit(
      constructPrompt([file], patchBuilder, convoBuilder)
    );
    if (patchWithPromptWithinLimit) {
      patchesWithinModelLimit.push(file);
    } else {
      patchesOutsideModelLimit.push(file);
    }
  });

  console.log(
    `@reviewChanges files within limits: ${patchesWithinModelLimit.length}`
  );
  const withinLimitsPatchGroups = processWithinLimitFiles(
    patchesWithinModelLimit,
    patchBuilder,
    convoBuilder
  );
  const exceedingLimitsPatchGroups = processOutsideLimitFiles(
    patchesOutsideModelLimit,
    patchBuilder,
    convoBuilder
  );
  console.log(`${withinLimitsPatchGroups.length} within limits groups.`);
  console.log(
    `${patchesOutsideModelLimit.length} files outside limit, skipping them.`
  );

  const groups = [...withinLimitsPatchGroups, ...exceedingLimitsPatchGroups];

  const feedbacks = await Promise.all(
    groups.map((patchGroup) => {
      return reviewFiles(patchGroup, patchBuilder, convoBuilder);
    })
  );
  try {
    return await responseBuilder(feedbacks);
  } catch (exc) {
    console.log("XML parsing error");
    console.log(exc);
    throw exc;
  }
};

const indentCodeFix = (
  file: string,
  code: string,
  lineStart: number
): string => {
  const fileLines = file.split("\n");
  const firstLine = fileLines[lineStart - 1];
  const codeLines = code.split("\n");
  const indentation = firstLine.match(/^(\s*)/)[0];
  const indentedCodeLines = codeLines.map((line) => indentation + line);
  return indentedCodeLines.join("\n");
};

const isCodeSuggestionNew = (
  contents: string,
  suggestion: CodeSuggestion
): boolean => {
  const fileLines = contents.split("\n");
  const targetLines = fileLines
    .slice(suggestion.line_start - 1, suggestion.line_end)
    .join("\n");
  if (targetLines.trim() == suggestion.correction.trim()) {
    // same as existing code.
    return false;
  }
  return true;
};

export const generateInlineComments = async (
  suggestion: PRSuggestion,
  file: PRFile
): Promise<CodeSuggestion> => {
  try {
    const messages = getInlineFixPrompt(file.current_contents, suggestion);
    const { function_call } = await generateChatCompletion({
      messages,
      functions: [INLINE_FIX_FUNCTION],
      function_call: { name: INLINE_FIX_FUNCTION.name },
    });
    if (!function_call) {
      throw new Error("No function call found");
    }
    const args = JSON.parse(function_call.arguments);
    const initialCode = String.raw`${args["code"]}`;
    const indentedCode = indentCodeFix(
      file.current_contents,
      initialCode,
      args["lineStart"]
    );
    const codeFix = {
      file: suggestion.filename,
      line_start: args["lineStart"],
      line_end: args["lineEnd"],
      correction: indentedCode,
      comment: args["comment"],
    };
    if (isCodeSuggestionNew(file.current_contents, codeFix)) {
      return codeFix;
    }
    return null;
  } catch (exc) {
    console.log(exc);
    return null;
  }
};

/**
 * Handle scenario where file was created or deleted
 * @param octokit
 * @param payload
 * @param file
 */
const preprocessFile = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  file: PRFile
) => {
  // Get the base and head branches of the PR
  const { base, head } = payload.pull_request;
  const baseBranch: BranchDetails = {
    name: base.ref,
    sha: base.sha,
    url: payload.pull_request.url,
  };
  const currentBranch: BranchDetails = {
    name: head.ref,
    sha: head.sha,
    url: payload.pull_request.url,
  };

  // Find old and new versions of the file
  const [oldContents, currentContents] = await Promise.all([
    getGitFile(octokit, payload, baseBranch, file.filename),
    getGitFile(octokit, payload, currentBranch, file.filename),
  ]);
  // if deleted
  if (oldContents.content != null) {
    file.old_contents = String.raw`${oldContents.content}`;
  } else {
    file.old_contents = null;
  }
  // if created
  if (currentContents.content != null) {
    file.current_contents = String.raw`${currentContents.content}`;
  } else {
    file.current_contents = null;
  }
};

/**
 * For each file, try the review process with the XML builder. If it fails, use the text builder.
 * @param files - PRFile[]: the files edited in the PR
 * @param builders - Builders[]: the builders to try
 * @returns the output of the builder that succeeds (aka reviewed changes) for each file
 */
const reviewChangesRetry = async (files: PRFile[], builders: Builders[]) => {
  // By definition, the for loop will loop through XML and then non-XML.
  // If it succeeds with the XML builder, it will return early and not try the non-XML builder.
  // If it fails with the XML builder, it will log an error and fall back to the non-XML builder.
  // The non-XML builder will always succeed.
  for (const { convoBuilder, responseBuilder } of builders) {
    try {
      console.log(
        `@reviewChangesRetry Trying with convoBuilder: ${convoBuilder.name}.`
      );
      return await reviewChanges(files, convoBuilder, responseBuilder);
    } catch (error) {
      console.log(
        `Error with convoBuilder: ${convoBuilder.name}, trying next one. Error: ${error}`
      );
    }
  }
  throw new Error("All convoBuilders failed.");
};

import { GROQ_MODEL } from "./llms/groq";
import { groq } from "./llms/groq";
/**
 * Filter out files to ignore and process the PR. Return a review with AI suggestions
 * @param octokit - the octokit instance for the specific installation
 * @param payload - the payload of the webhook event
 * @param files - the list of files edited in the PR
 * @param includeSuggestions - whether to include AI suggestions in the review
 * @returns the review with AI suggestions
 */
export const processPullRequest = async (
  octokit: Octokit,
  payload: WebhookEventMap["pull_request"],
  files: PRFile[],
  includeSuggestions = false
) => {
  console.dir({ files }, { depth: null });
  const filteredFiles = files.filter((file) => filterPRFile(file));
  console.dir({ filteredFiles }, { depth: null });
  if (filteredFiles.length == 0) {
    console.log(
      "Nothing to comment on, all files were filtered out. The PR Agent does not support the following file types: pdf, png, jpg, jpeg, gif, mp4, mp3, md, json, env, toml, svg, package-lock.json, yarn.lock, .gitignore, package.json, tsconfig.json, poetry.lock, readme.md"
    );
    return {
      review: null,
      suggestions: [],
    };
  }
  await Promise.all(
    filteredFiles.map((file) => {
      return preprocessFile(octokit, payload, file);
    })
  );

  const owner = payload.repository.owner.login;
  const repoName = payload.repository.name;
  const curriedXMLResponseBuilder = curriedXmlResponseBuilder(owner, repoName);
  const reviewComments = await reviewChangesRetry(filteredFiles, [
    // convoBuilder takes a patch and returns a chat history object for chat completion. The chat history object has items with role "system", with a prompt for the LLM, and "user", with the patch and .
    // responseBuilder takes the feedback (list of LLM responses) and returns a structured response (comment + structured feedback)
    {
      convoBuilder: getXMLReviewPrompt,
      responseBuilder: curriedXMLResponseBuilder,
    },
    {
      convoBuilder: getReviewPrompt,
      responseBuilder: basicResponseBuilder,
    },
  ]);

  console.dir({ reviewComments }, { depth: null });
  let filteredInlineComments: CodeSuggestion[] = [];
  if (includeSuggestions) {
    let inlineComments: CodeSuggestion[] = [];
    if (reviewComments.structuredComments.length > 0) {
      console.log("STARTING INLINE COMMENT PROCESSING");
      inlineComments = await Promise.all(
        reviewComments.structuredComments.map((suggestion) => {
          // find relevant file
          const file = files.find(
            (file) => file.filename === suggestion.filename
          );
          if (file == null) {
            return null;
          }
          return generateInlineComments(suggestion, file);
        })
      );
    }
    filteredInlineComments = inlineComments.filter(
      (comment) => comment !== null
    );
  }

  return {
    review: reviewComments,
    suggestions: filteredInlineComments,
  };
};
