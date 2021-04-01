import commander from 'commander';
import { createLogger } from '../logging';
import * as fs from 'fs';
import { findAllJSFilesRecursively, findAllTransitivelyLoadedModules } from './resolver';

commander
  .arguments('<root-file> <out>')
  .description(``)
  .option('-d, --debug', 'Enable debug logging')
  .option('-r, --redundant-files', 'print a list of redundant modules')
  .action(async function (rootFile: string, out: string, options: any): Promise<void> {
    const cwd = process.cwd();
    const logger = createLogger(`transitive-module-resolver`, options.debug);
    logger.info(`running transitive module resolver on ${rootFile}`);
    const transitivelyResolvedModules = await findAllTransitivelyLoadedModules(rootFile);
    await fs.promises.writeFile(out, JSON.stringify(transitivelyResolvedModules, null, 2));

    if (options.redundantFiles) {
      const allJsFiles = await findAllJSFilesRecursively(cwd);
      const redundantFiles = allJsFiles.filter((f) => !transitivelyResolvedModules.includes(f));
      console.log(`redundant files ${redundantFiles.join('\n')}`);
    }

    logger.info(`output written to ${out}`);
  })
  .parse(process.argv);
