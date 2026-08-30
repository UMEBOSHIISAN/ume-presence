"use strict";

const {
  formatCommandResult,
  parseAppCommand,
  runAppCommand,
} = require("./app-command.cjs");

function hasManagementNamespace(argv) {
  return Array.isArray(argv) && argv.some(
    (argument) => typeof argument === "string"
      && (argument.startsWith("--login-startup") || argument.startsWith("--character")),
  );
}

function commandFailure(errorCode) {
  return Object.freeze({
    kind: "command",
    action: null,
    ok: false,
    errorCode,
    exitCode: 1,
  });
}

function writeLine(stdout, line) {
  return new Promise((resolve, reject) => {
    try {
      stdout.write(line, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function bootstrapPersona({
  app,
  argv = process.argv,
  runRuntime,
  runCommand = (command) => runAppCommand(command, { app }),
  stdout = process.stdout,
}) {
  if (!hasManagementNamespace(argv)) return runRuntime();

  let result;
  try {
    await app.whenReady();
    let command;
    try {
      command = parseAppCommand(argv);
    } catch {
      result = commandFailure("INVALID_APP_COMMAND");
    }
    if (command) result = await runCommand(command);
  } catch {
    result = commandFailure("COMMAND_FAILED");
  }

  const line = formatCommandResult(result ?? commandFailure("COMMAND_FAILED"));
  const formatted = JSON.parse(line);
  try {
    await writeLine(stdout, line);
  } catch {
    app.exit(1);
    return;
  }
  app.exit(formatted.exitCode);
}

module.exports = { bootstrapPersona };
