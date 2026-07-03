import { writeFileSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { loadConfigFile } from "../config/load.js";
import { runReview } from "../engine/run-review.js";
import { builtinChecks } from "../engine/registry.js";
import { renderConsole } from "../reporters/console.js";
import { renderJson } from "../reporters/json.js";
import type { CheckOverride, Environment, SiteReviewConfig } from "../types.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

interface CliOptions {
  env?: string;
  config?: string;
  checks?: string;
  skip?: string;
  maxPages?: string;
  failThreshold?: string;
  output?: string;
  format: string;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exitCode = 0;
  const program = new Command("site-review")
    .argument("<url>", "base URL of the site to review")
    .option("--env <environment>", "local | ci | production")
    .option("--config <path>", "path to a site-review config file")
    .option("--checks <ids>", "comma-separated check ids to run exclusively")
    .option("--skip <ids>", "comma-separated check ids to skip")
    .option("--max-pages <n>", "maximum pages to crawl")
    .option("--fail-threshold <n>", "minimum overall score to pass")
    .option("--output <file>", "write the JSON report to a file")
    .option("--format <format>", "json | console | both", "both")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        io.out(text);
      },
      writeErr: (text) => {
        io.err(text);
      },
    })
    .action(async (url: string, opts: CliOptions) => {
      const validEnvironments: Environment[] = ["local", "ci", "production"];
      if (opts.env !== undefined && !validEnvironments.includes(opts.env as Environment)) {
        throw new Error(`Invalid value for --env: "${opts.env}" (expected local|ci|production)`);
      }
      const parsePositiveNumber = (flag: string, value: string): number => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid value for ${flag}: "${value}" (expected a number >= 0)`);
        }
        return parsed;
      };
      const maxPages =
        opts.maxPages !== undefined ? parsePositiveNumber("--max-pages", opts.maxPages) : undefined;
      const failThreshold =
        opts.failThreshold !== undefined
          ? parsePositiveNumber("--fail-threshold", opts.failThreshold)
          : undefined;

      const checks: Record<string, boolean | CheckOverride> = {};
      for (const id of opts.skip?.split(",") ?? []) checks[id] = false;
      if (opts.checks !== undefined) {
        const keep = new Set(opts.checks.split(","));
        for (const check of builtinChecks) {
          if (!keep.has(check.id)) checks[check.id] = false;
        }
      }
      const cliConfig: SiteReviewConfig = {
        checks,
        ...(opts.env !== undefined && { environment: opts.env as Environment }),
        ...(maxPages !== undefined && { maxPages }),
        ...(failThreshold !== undefined && { failThreshold }),
      };
      const configFile = await loadConfigFile(process.cwd(), opts.config);
      const report = await runReview({ url, configFile, cliConfig });
      const json = renderJson(report);
      if (opts.output !== undefined) writeFileSync(opts.output, json);
      if (opts.format === "console" || opts.format === "both") io.out(`${renderConsole(report)}\n`);
      if (opts.format === "json" || (opts.format === "both" && opts.output === undefined)) {
        io.out(`${json}\n`);
      }
      exitCode = report.grade === "pass" ? 0 : 1;
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`${JSON.stringify({ tool: "site-review", error: message })}\n`);
    return 2;
  }
}
