#!/usr/bin/env node

import process from "node:process";
import { printResult, runCli } from "../src/cli.mjs";

runCli(process.argv.slice(2))
  .then(printResult)
  .catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
