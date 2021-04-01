import { Program } from 'estree';
import { promisify as p } from 'util';
import * as fs from 'fs';
import { parse as acornParse } from 'acorn';
// @ts-ignore
import { parse as acornLooseParse } from 'acorn-loose';
import { createLogger } from '../logging';
const logger = createLogger('parsing', 'debug');

const SPECIAL_SHEBANG = `SPECIAL_SHEBANG!@!@`;
export async function parseFileWithAcorn(sourceFile: string): Promise<Program> {
  let module: Program;
  try {
    let programSource = await p(fs.readFile)(sourceFile, 'utf-8');

    if (programSource.startsWith('#')) {
      const lineShiftCharacter = programSource.includes('\r\n') ? '\r\n' : '\n';
      programSource = '//' + programSource.replace(lineShiftCharacter, `${SPECIAL_SHEBANG}${lineShiftCharacter}`);
    }

    try {
      //@ts-ignore I don't know why there's a warning produced here
      module = acornParse(programSource, getParserOptions());
    } catch (e) {
      module = acornLooseParse(programSource, getParserOptions());
    }
  } catch (e) {
    logger.debug(`Failed to parse JavaScript file ${sourceFile}. Returning empty set of patterns`);
    throw new Error('Failed parsing');
  }
  return module;
}

function getParserOptions(): any {
  return {
    sourceType: 'module',
    locations: true,
    allowHashBang: true,
    ranges: true,
    preserveParens: true,
    allowReturnOutsideFunction: true,
  };
}
