import { createLogger } from '../logging';
import { isAbsolute, resolve } from 'path';
import { StaticConfiguration } from '../static-configuration';
import { spawn } from 'child_process';

export interface RunAnalysisOptions {
  debug?: boolean;
  nodehome?: string;
}

export async function runAnalysis(
  analysis: 'api' | 'call-graph',
  moduleFile: string,
  out: string,
  options: RunAnalysisOptions,
  extraParams: string | undefined = undefined
): Promise<void> {
  const logger = createLogger(`analysis`, options.debug ? 'debug' : 'info');

  if (analysis !== 'api' && analysis !== 'call-graph') {
    logger.error(`<analysis> argument must either be 'api' or 'call-graph'`);
    process.exit(1);
  }

  const node_home = options.nodehome || process.env.NODE_HOME;

  if (!node_home) {
    logger.error(
      `Graal node installation folder must be specified with either --node-home option or NODE_HOME env variable`
    );
    process.exit(-1);
  }

  const analysisFile = resolve(
    StaticConfiguration.nodeProfAnalysisFolder,
    analysis === 'api' ? 'api-inference-analysis.js' : 'call-graph-analysis.js'
  );
  const runnerFile = resolve(StaticConfiguration.nodeProfAnalysisFolder, 'runner.js');
  if (!isAbsolute(moduleFile)) {
    moduleFile = resolve(process.cwd(), moduleFile);
  }
  const args = [
    '--jvm',
    '--experimental-options',
    `--vm.Dtruffle.class.path.append=${StaticConfiguration.nodeprofJar}`,
    `--nodeprof.Scope=${analysis === 'api' ? 'all' : 'module'}`,
    '--nodeprof',
    `${StaticConfiguration.jalangiAnalysis}`,
    '--analysis',
    analysisFile,
    '--initParam',
    `module:${moduleFile}`,
    '--initParam',
    `out:${out}`,
    runnerFile,
    `${moduleFile}`,
    `${analysis}`,
    extraParams ? `-e \'[${extraParams}]\'` : '',
    options.debug ? '--debug' : '',
  ];

  const node = resolve(node_home, 'bin/node');
  logger.debug(`running nodeProf analysis command: ${node} ${args.join(' ')}`);
  return new Promise((resolve, _reject) => {
    const p = spawn(node, args, { detached: true });
    const timeout = setTimeout(() => {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch (e) {
        logger.error(`Cannot kill process: ${e}`);
      }
      throw new Error(`Could not create package model for ${moduleFile} due to timeout`);
    }, 300 * 1000);

    p.stdout.on('data', (data) => {
      process.stdout.write(data);
    });
    p.stderr.on('data', (data) => {
      process.stderr.write(data);
    });
    p.on('error', (data) => {
      logger.error(
        `Error (${data}) when running dynamic analysis. Will continue but beware of dynamic analysis result problems.`
      );
      resolve();
    });
    p.on('close', (code) => {
      if (code !== 0) {
        logger.error(
          `non-zero exit code (${code}) when running dynamic analysis. Will continue but beware of dynamic analysis result problems.`
        );
        resolve();
      } else {
        resolve();
      }
    });
    p.on('exit', () => {
      clearTimeout(timeout);
    });
  });
}
