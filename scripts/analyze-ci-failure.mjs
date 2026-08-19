#!/usr/bin/env node
// Analyzes GitHub Actions CI failure logs with Claude and prints a root-cause
// + fix suggestion as Markdown, for posting as a PR comment. See the
// `ai-failure-analysis` job in .github/workflows/ci.yml for how this is
// invoked — it's given the output of `gh run view --log-failed`, not full
// job logs, so it only ever sees what actually failed.
import Anthropic from "@anthropic-ai/sdk";
import { roleConfig, resolveApiKey } from "@medinstru/config";

const ANALYSIS = roleConfig("failureAnalysis");
import { readFileSync } from "node:fs";

const logPath = process.argv[2];
if (!logPath) {
  console.error("Usage: analyze-ci-failure.mjs <failed-steps-log-file>");
  process.exit(1);
}

// Keeps the request focused and cheap — the actual error is almost always
// near the end of a failed step's log, not the setup/install noise at the
// start.
const MAX_LOG_CHARS = ANALYSIS.maxInputChars;
let log = readFileSync(logPath, "utf8");
if (log.length > MAX_LOG_CHARS) {
  log = log.slice(-MAX_LOG_CHARS);
}

// See ai-code-review.mjs -- resolved from the role's apiKeyEnv, not the
// SDK default.
const client = new Anthropic({ apiKey: resolveApiKey("failureAnalysis") });

const response = await client.messages.create({
  model: ANALYSIS.model,
  max_tokens: ANALYSIS.maxOutputTokens,
  system:
    "You are analyzing GitHub Actions CI failure logs for a software engineering team. " +
    "Identify the root cause and suggest a concrete fix. Be concise and specific — cite " +
    "exact error messages, file paths, and line numbers from the log where present. " +
    "Format as Markdown with a '## Root cause' section and a '## Suggested fix' section. " +
    "If the log doesn't contain enough information to diagnose confidently, say so plainly " +
    "rather than guessing.",
  messages: [
    {
      role: "user",
      content: `Here are the logs from the failed steps of a GitHub Actions CI run:\n\n\`\`\`\n${log}\n\`\`\``,
    },
  ],
});

const text = response.content
  .filter((block) => block.type === "text")
  .map((block) => block.text)
  .join("\n");

console.log(text);
