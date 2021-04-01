#!/usr/bin/env node
import { resolve } from 'path';

require('source-map-support').install();
import commander from 'commander';
import { VulnerabilityScanner } from './scanner';
import { writeCGAsDot, PropertyReadsOnLibraryObjectStrategies } from '../usage-model-generator/compute-call-graph';
import { SetWithToStringEquality } from '../util/collections';

commander
  .arguments('<client-folder>')
  .option(
    '--client-main [main file relative to client-folder]',
    'specify the file containing the program entry point (default resolved file is used otherwise)'
  )
  .option('-o, --out [file]', 'output the callgraph as dot to this file')
  .option('-d, --debug', 'Enable debug logging')
  .action(async function (clientFolder: string, options: any): Promise<void> {
    const mainFile = options.clientMain ? resolve(clientFolder, options.clientMain) : undefined;
    const scanner = new VulnerabilityScanner(clientFolder, mainFile, options.debug);
    await scanner.runScanner(true, PropertyReadsOnLibraryObjectStrategies.USE_FIELD_BASED_FROM_LIBRARY);
    const cg = scanner.getCallGraphFromMain();

    if (options.out) {
      await writeCGAsDot(
        options.out,
        cg.getNodes(),
        new SetWithToStringEquality(),
        cg.edges,
        cg.edgeToTargets,
        new SetWithToStringEquality()
      );
    }
  });
commander.parse(process.argv);
