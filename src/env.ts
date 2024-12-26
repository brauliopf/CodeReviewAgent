import * as dotenv from "dotenv";
import { createPrivateKey } from "crypto";
import chalk from "chalk";

// Load environment variables
dotenv.config();

export const env = {
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
} as const;

let valid = true;

// [key as keyof typeof env]: key in the union of keys of env
// if env[key] is undefined, log woith chalk (styled terminal output)!
for (const key in env) {
  if (!env[key as keyof typeof env]) {
    console.log(
      chalk.red("✖") +
        chalk.gray(" Missing required env var: ") +
        chalk.bold(`process.env.${key}`)
    );
    valid = false;
  }
}

// Validate GitHub private key
try {
  createPrivateKey(env.GITHUB_PRIVATE_KEY);
} catch (error) {
  console.log(
    chalk.red(
      "\n✖ Invalid GitHub private key format for " +
        chalk.bold(`process.env.GITHUB_PRIVATE_KEY`) +
        "\n"
    ) +
      chalk.gray("  • Must start with: ") +
      chalk.bold("-----BEGIN RSA PRIVATE KEY-----\n") +
      chalk.gray("  • Must end with:   ") +
      chalk.bold("-----END RSA PRIVATE KEY-----\n")
  );
  valid = false;
}

if (!valid) {
  console.log(
    chalk.yellow("\n⚠ ") +
      chalk.bold("Please check your .env file and try again.\n")
  );
  process.exit(1);
}
