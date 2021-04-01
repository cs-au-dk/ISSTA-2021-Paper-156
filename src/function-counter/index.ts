import commander from 'commander';
import { getFunctionCount } from './resolver';

commander
  .arguments('<file>')
  .description(``)
  .option('-d, --debug', 'Enable debug logging')
  .action(async function (file: string, _options: any): Promise<void> {
    console.log(await getFunctionCount(file));
  })
  .parse(process.argv);
