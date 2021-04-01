import fs from 'fs';
import { IllegalLoad } from './IllegalLoad';
import { relative } from 'path';
const isBuiltIn = require('is-builtin-module');

const whitelistFile = process.env.WHITELIST_FILE;
if (!whitelistFile) {
  console.error(`ENV variable WHITELIST_FILE must point to a json file with a list of whitelisted modules`);
  process.exit(1);
}

const outFile = process.env.OUTFILE;
if (!outFile) {
  console.error(`ENV variable OUTFILE must be set`);
  process.exit(1);
}

const applicationDirectory = process.env.APPLICATION_DIRECTORY;
if (!applicationDirectory) {
  console.error(`ENV variable APPLICATION_DIRECTORY must be set`);
  process.exit(1);
}

const illegalLoads: IllegalLoad[] = [];
const whitelistedModules = JSON.parse(fs.readFileSync(whitelistFile as string, { encoding: 'utf-8' }));

// is set to true the first time we encounter a load of a file in the application directory which is not in its node_modules directory.
// this is required to avoid checking the load of test-suite and npm related files that load before the test suite actually starts executing.
let hasStartedRunningClientCode = false;

function isBuiltInChk(modulePath: string) {
  return isBuiltIn(modulePath) || modulePath.startsWith('nodejs');
}

export function checkLoad(modulePath: string, name: string, currentFile: string) {
  if (modulePath) {
    if (
      !hasStartedRunningClientCode &&
      modulePath.startsWith(applicationDirectory as string) &&
      !modulePath.includes('node_modules')
    ) {
      hasStartedRunningClientCode = true;
    }
    if (hasStartedRunningClientCode && !isBuiltInChk(modulePath) && !whitelistedModules.includes(modulePath)) {
      illegalLoads.push({
        loadedFile: relative(applicationDirectory as string, modulePath),
        moduleName: name,
        loadedFromFile: relative(applicationDirectory as string, currentFile),
      });
    }
  }
}

function exitHandler(options: any, error: any) {
  fs.writeFileSync(outFile as string, JSON.stringify(illegalLoads), { encoding: 'utf-8' });
  if (error) console.log(error);
  if (options.exit) process.exit();
}

//do something when app is closing
process.on('exit', exitHandler.bind(null, { cleanup: true }));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, { exit: true }));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, { exit: true }));
