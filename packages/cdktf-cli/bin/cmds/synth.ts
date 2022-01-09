import yargs from "yargs";
import React from "react";
import { Synth } from "./ui/synth";
import { config as cfg } from "@cdktf/provider-generator";
import { renderInk } from "./helper/render-ink";
import * as fs from "fs-extra";
import { displayVersionMessage } from "./helper/version-check";
import { throwIfNotProjectDirectory } from "./helper/check-directory";
import { checkEnvironment } from "./helper/check-environment";

const config = cfg.readConfigSync();

class Command implements yargs.CommandModule {
  public readonly command = "synth [stack] [OPTIONS]";
  public readonly describe =
    "Synthesizes Terraform code for the given app in a directory.";
  public readonly aliases = ["synthesize"];

  public readonly builder = (args: yargs.Argv) =>
    args
      .positional("stack", {
        desc: "Stack to output when using --json flag",
        type: "string",
      })
      .option("app", {
        default: config.app,
        desc: "Command to use in order to execute cdktf app",
        alias: "a",
      })
      .option("output", {
        default: config.output,
        desc: "Output directory",
        alias: "o",
      })
      .option("json", {
        type: "boolean",
        desc: "Provide JSON output for the generated Terraform configuration.",
        default: false,
      })
      .option("check-code-maker-output", {
        type: "boolean",
        desc: "Should `codeMakerOutput` existence check be performed? By default it will be checked if providers or modules are configured.",
        default: cfg.shouldCheckCodeMakerOutput(config),
      })
      .showHelpOnFail(true);

  public async handler(argv: any) {
    throwIfNotProjectDirectory("synth");
    await displayVersionMessage();
    await checkEnvironment("synth");
    const command = argv.app;
    const outdir = argv.output;
    const jsonOutput = argv.json;
    const checkCodeMakerOutput = argv.checkCodeMakerOutput;
    const stack = argv.stack;

    if (
      checkCodeMakerOutput &&
      !(await fs.pathExists(config.codeMakerOutput))
    ) {
      console.error(
        `ERROR: synthesis failed, run "cdktf get" to generate providers in ${config.codeMakerOutput}`
      );
      process.exit(1);
    }

    await renderInk(
      React.createElement(Synth, {
        targetDir: outdir,
        targetStack: stack,
        synthCommand: command,
        jsonOutput: jsonOutput,
      })
    );
  }
}

module.exports = new Command();
