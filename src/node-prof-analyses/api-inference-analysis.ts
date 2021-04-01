// DO NOT INSTRUMENT
import { IID, Jalangi, JalangiAnalysis } from '../../typings/Jalangi';
import { relative, resolve } from 'path';
import { writeFileSync } from 'fs';
import { StaticConfiguration } from '../static-configuration';
import { PackageModel } from '../usage-model-generator/usage-model';
import { getSourceLocation } from './nodeprof-tools';

declare const J$: Jalangi;

if (!J$.initParams.module) {
  console.error('Error: no module selected, use --initParam module:...');
  process.exit(-1);
}

if (!J$.initParams.out) {
  console.error('Error: no outFile specified, use --initParam out:...');
  process.exit(-1);
}

const cwd = process.cwd();
const moduleName = J$.initParams.module;
let moduleObj: any = undefined;
// maps moduleRelatedObjects to their string representation.
// e.g., maps module.exports.x.foo to x.foo
const moduleRelatedObjects: Map<object, string> = new Map();
const libraryFunctionNames: Map<Function, string> = new Map();
// for built-ins we use a string representation instead of an actual location (see builtinEnter)
// for example, Object.defineProperty is given the name Object.defineProperty.
const mainModulePackageModel: PackageModel = {};
let enteringLibraryFunction = false;
const requireFunctions: WeakSet<Function> = new WeakSet(); // set of known 'require' functions
const bindMap: Map<Function, Function> = new Map();
function isOnClientSide(iid: IID) {
  return J$.iidToLocation(iid).includes('runner.js');
}
const mapBuiltinFunctionsNotInvokedInBuiltinEnter = new Map([
  [Buffer.isBuffer, 'Buffer.isBuffer'],
  [Buffer.compare, 'Buffer.compare'],
  [require('util').inherits, 'util.inherits'],
  [require('util').deprecate, 'util.deprecate'],
  [require('util').getSystemErrorName, 'util.getSystemErrorName'],
  [require('stream'), 'stream'],
  [require('child_process').spawnSync, 'child_process.spawnSync'],
  [setInterval, 'setInterval'],
  [setImmediate, 'setImmediate'],
  [queueMicrotask, 'queueMicrotask'],
  [process.nextTick, 'process.nextTick'],
]);

const analysis: JalangiAnalysis = {
  // before function or constructor call
  invokeFunPre: function (iid: IID, f, base, _args, _isConstructor: boolean, _isMethod) {
    if (typeof f === 'function' && f.name === 'require') {
      requireFunctions.add(f);
    }

    if ((moduleRelatedObjects.has(base) && isOnClientSide(iid)) || f === moduleObj) {
      // if calling the library module object itself.
      enteringLibraryFunction = true;
    }
  },

  /**
   * These callbacks are called before the execution of a builtin function body starts and after it completes.
   **/
  // @ts-ignore
  builtinEnter: function (name, func, dis, args) {
    if (enteringLibraryFunction) {
      const funcName = libraryFunctionNames.get(func);
      enteringLibraryFunction = false;
      if (moduleObj === func || (bindMap.has(moduleObj) && bindMap.get(moduleObj) === func)) {
        mainModulePackageModel[StaticConfiguration.mainModuleIdentifier] = name;
      } else if (!funcName) {
        console.log(`Error retrieving function name for call to built-in function ${name}`);
        if (name === 'Promise')
          // For async functions Promise is called before the actual function
          enteringLibraryFunction = true;
      } else {
        mainModulePackageModel[funcName] = name;
      }
    }
  },
  // @ts-ignore
  builtinExit: function (name, f, dis, args, returnVal, exceptionVal) {
    if (name === 'Function.prototype.bind') {
      bindMap.set(returnVal, dis);
    }
  },

  functionEnter: function (iid: IID, func: Function, receiver: object, _args: any[]) {
    if (enteringLibraryFunction) {
      const sourceLocationString = J$.iidToLocation(iid);
      if (sourceLocationString.startsWith('(*'))
        // Do not continue for internal calls
        return;
      try {
        enteringLibraryFunction = false;
        const location = getSourceLocation(sourceLocationString);
        const relativePath = relative(cwd, location.source as string);
        location.source = `./${relativePath}`;
        if (func === moduleObj || (bindMap.has(moduleObj) && bindMap.get(moduleObj) === func)) {
          mainModulePackageModel[StaticConfiguration.mainModuleIdentifier] = location;
        } else {
          const funcName = libraryFunctionNames.get(func);

          if (!funcName) {
            console.log(`Error retrieving function name for function at ${sourceLocationString}`);
          } else {
            const receiverPath = moduleRelatedObjects.get(receiver);
            const funcPath = receiverPath === '' ? funcName : `${receiverPath}.${funcName}`;
            mainModulePackageModel[funcPath] = location;
          }
        }
      } catch (e) {
        console.log(`error retrieving function path for function at ${sourceLocationString}`);
      }
    }
  },

  getField: function (iid: IID, base: object, offset: any, val: any, _isComputed, _isOpAssign, _isMethodCall) {
    if (moduleRelatedObjects.has(base) && isOnClientSide(iid)) {
      const receiverPath = moduleRelatedObjects.get(base);
      const valType = getValueType(val);
      if (valType === 'function') {
        libraryFunctionNames.set(val, offset);
      } else {
        const valPath = receiverPath === '' ? offset : `${receiverPath}.${offset}`;
        if (valType === 'object') {
          moduleRelatedObjects.set(val, valPath);
          mainModulePackageModel[valPath] = valType;
        } else {
          mainModulePackageModel[valPath] = valType;
        }
      }
    }
  },

  invokeFun: function (_iid: IID, f: Function, _base, args: any[], result: any, _isConstructor, _isMethod) {
    if (requireFunctions.has(f) && arguments.length > 0) {
      try {
        const moduleLoadString = args[0];
        const requiredModule = require.resolve(moduleLoadString);
        if (resolve(requiredModule) === resolve(moduleName)) {
          moduleRelatedObjects.set(result, '');
          moduleObj = result;
          if (typeof moduleObj !== 'function')
            mainModulePackageModel[StaticConfiguration.mainModuleIdentifier] = getValueType(moduleObj);
          if (mapBuiltinFunctionsNotInvokedInBuiltinEnter.has(moduleObj))
            mainModulePackageModel[
              StaticConfiguration.mainModuleIdentifier
            ] = mapBuiltinFunctionsNotInvokedInBuiltinEnter.get(moduleObj) as string;
          if (moduleObj.name === 'require') {
            // For some reason these do not match require: requireFunctions.has(moduleObj) ||  result === require - If we trigger this on another function that is the real require, mainModulePackageModel[StaticConfiguration.mainModuleIdentifier] will be overwritten
            mainModulePackageModel[StaticConfiguration.mainModuleIdentifier] = 'require';
          }
        }
      } catch (e) {}
    }
  },

  endExecution() {
    const outFile = J$.initParams.out;
    writeFileSync(outFile, JSON.stringify(mainModulePackageModel, null, 2));
    console.log(`analysis output written to ${outFile}`);
  },
};

function getValueType(val: any) {
  let valType:
    | 'string'
    | 'number'
    | 'function'
    | 'object'
    | 'boolean'
    | 'undefined'
    | 'regexp'
    | 'bigint'
    | 'symbol' = typeof val;

  if (valType === 'object' && val && val.constructor === RegExp) valType = 'regexp'; // null also has type object
  return valType;
}

J$.analysis = analysis;
