/**
 * @param {string} url
 * @param {{ format: string }} context
 * @param {Function} defaultGetSource
 * @returns {Promise<{ source: !(SharedArrayBuffer | string | Uint8Array) }>}
 */
//import {checkLoad} from "./util";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { checkLoad } = require('../../dist/module-whitelist-checker/util');
//import {checkLoad} from "../../dist/module-whitelist-checker/util";

export async function resolve(specifier, context, defaultResolve) {
  let resolved;
  try {
    resolved = defaultResolve(specifier, context, defaultResolve);
    if (resolved && resolved.url) {
      const filePrefix = 'file://';
      const path = resolved.url.startsWith(filePrefix) ? resolved.url.substring(filePrefix.length) : resolved.url;
      checkLoad(path, specifier);
    }
  } catch (e) {
    console.log(`issue when calling default resolve on `, specifier);
  }
  return resolved;
}
