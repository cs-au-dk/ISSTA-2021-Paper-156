import commander from 'commander';
import { createLogger } from '../logging';

commander
  .arguments('<module-file> <analysis>')
  .description(
    `Runs the dynamic analysis
<analysis> is should either be 'api' for running the api-inference analysis or 'call-graph' for running the dynamic call graph analysis`
  )
  .option('-d, --debug', 'Enable debug logging')
  .option('-e, --extra <args>', 'These args should be wrapped in [] and will be passed as argv of the module')
  .action(async function (moduleFile: string, analysis: 'call-graph' | 'api', options: any) {
    const logger = createLogger(`runner`, options.debug ? 'debug' : 'info');

    if (analysis !== 'api' && analysis !== 'call-graph') {
      logger.error(`<analysis> argument must either be 'api' or 'call-graph'`);
      process.exit(1);
    }

    function isClass(v: any) {
      return typeof v === 'function' && /^\s*class\s+/.test(v.toString());
    }

    const builtinFunctions = [
      Function.prototype.call,
      Function.prototype.apply,
      Function.prototype.bind,
      Function.prototype.toString,
      Function,
      global,
    ];
    let module;
    let extraArgs = '';
    if (options.extra) {
      const e: string = options.extra.trim();
      // remove the []
      extraArgs = e.slice(0, e.length - 1).slice(1);
    }
    const argv = process.argv;
    try {
      process.argv = ['node', moduleFile, ...extraArgs.split(' ')];
      module = require(moduleFile);
    } catch (e) {
      logger.error(`loading module ${moduleFile} failed with error ${e}`);
    }
    process.argv = argv;

    if (typeof module === 'function') {
      try {
        logger.debug(`attempting to call the module which is itself a function`);
        Promise.resolve(isClass(module) ? new module() : module()).catch((e) => {
          logger.debug(`call to module() resulted in promise that failed with error ${e}`);
        });
      } catch (e) {
        logger.debug(`call to module failed with error ${e}`);
      }
    }

    // currently, only the api structure analysis will try to invoke every method.
    if (analysis === 'api' && (typeof module === 'function' || typeof module === 'object')) {
      let hasSeen: Set<object | Function> = new Set();
      const process = (obj: { [index: string]: any }) => {
        const objProps = Object.getOwnPropertyNames(obj);
        for (const prop of objProps) {
          try {
            const objVal = obj[prop];
            if (builtinFunctions.includes(objVal)) continue;
            if (typeof objVal === 'function') {
              try {
                logger.debug(`attempting to call function module.${prop}`);
                Promise.resolve(isClass(obj[prop]) ? new obj[prop]() : obj[prop]()).catch((e) => {
                  logger.debug(`call to module.${prop} resulted in promise that failed with error ${e}`);
                });
                logger.debug(`done calling function module.${prop}`);
              } catch (e) {
                logger.debug(`call to module.${prop} failed with error ${e}`);
              }
            }
            if (
              (typeof objVal === 'function' || (typeof objVal === 'object' && objVal !== null)) &&
              !hasSeen.has(objVal)
            ) {
              hasSeen.add(objVal);
              process(objVal);
            }
          } catch (e) {
            logger.debug(`Failed module.${prop} with error ${e}`); // For instance if obj[prop] is a getter that fails
          }
        }
      };
      process(module);
    }
    process.exit(0);
  });

commander.parse(process.argv);
