#!/usr/bin/env node
import commander from 'commander';
import { runAnalysis, RunAnalysisOptions } from './analysis';

commander
  .arguments('<analysis> <module-file> <out>')
  .description(
    `Runs the API structure analysis.
<analysis> is should either be 'api' for running the api-inference analysis or 'call-graph' for running the dynamic call graph analysis 
<module-file> is a path to the to-be-analyzed module, and <out> specifies the output file path`
  )
  //typically ....workspace-nodeprof/graal/sdk/latest_graalvm_home/
  .option(
    '-n, --node-home',
    'specify the location of the graal node installation (alternatively, set with NODE_HOME env variable)'
  )
  .option('-d, --debug', 'Enable debug logging')
  .action(async function (
    analysis: 'api' | 'call-graph',
    moduleFile: string,
    out: string,
    options: RunAnalysisOptions
  ): Promise<void> {
    runAnalysis(analysis, moduleFile, out, options);
  });

commander.parse(process.argv);
