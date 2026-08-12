#!/usr/bin/env node
import { runFixtureCli } from "./cli.js";

const exitCode = await runFixtureCli(process.argv.slice(2));
process.exitCode = exitCode;
