// DO NOT INSTRUMENT

// NodeProf instrumentation callbacks
import { IID, Jalangi, JalangiAnalysis } from '../../typings/Jalangi';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { DynamicCallEdge, stringifySourceLocation } from '../soundness-tester/soundness-tester';
import { SetWithToStringEquality } from '../util/collections';
import { SourceLocation } from 'estree';
import * as path from 'path';
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

const moduleName = J$.initParams.module;
let callerIID: IID | undefined;
let enableAnalysis = false;

class DynamicEdgeImpl implements DynamicCallEdge {
  constructor(public from: SourceLocation, public to: SourceLocation, public isLoad: boolean) {}

  toString(): string {
    return `${stringifySourceLocation(this.from)}->${stringifySourceLocation(this.to)}[isLoad:${this.isLoad}]`;
  }
}

const edges: SetWithToStringEquality<DynamicEdgeImpl> = new SetWithToStringEquality();
const requireFunctions: WeakSet<Function> = new WeakSet(); // set of known 'require' functions

function isMainModuleLoad(f: Function, args: any[]): boolean {
  if (requireFunctions.has(f)) {
    try {
      const moduleLoadString = args[0];
      const requiredModule = require.resolve(moduleLoadString);

      if (resolve(requiredModule) === resolve(moduleName)) {
        return true;
      }
    } catch (e) {}
  }
  return false;
}

const analysis: JalangiAnalysis = {
  // before function or constructor call

  invokeFun(
    _iid: IID,
    f: Function,
    _base: any,
    args: any[],
    _result: any,
    _isConstructor: boolean,
    _isMethod: boolean,
    _functionIid: IID,
    _functionSid: IID
  ) {
    // if the main module load has excited.
    if (isMainModuleLoad(f, args)) {
      enableAnalysis = false;
    }
  },

  // @ts-ignore
  builtinEnter: function (name, func, dis, args) {
    if (!args.some((a: any) => typeof a === 'function')) callerIID = undefined;
  },

  invokeFunPre: function (iid: IID, f, _base, args, _isConstructor: boolean, _isMethod) {
    if (f.name === 'require') {
      requireFunctions.add(f);
    }

    // The callee iid is not being set by NodeProf (although it is in the Jalangi API specification)
    // which is why we have to use the functionEnter hook instead.
    if (isMainModuleLoad(f, args)) {
      enableAnalysis = true;
    }

    if (enableAnalysis) {
      // graceful-fs is used internally by Graal's require, so we have to filter those edges.
      // Notice, even tough 'require' is seen as an internal function by NodeProf that is not the case for its dependencies.
      if (!J$.iidToLocation(iid).includes('graceful-fs')) {
        callerIID = iid;
      }
    }

    // if calling a require, then we add an edge to the resolved module
    if (requireFunctions.has(f) && enableAnalysis) {
      try {
        const cwd = process.cwd();
        const toBeLoadedModulePath = path.relative(cwd, require.resolve(args[0], { paths: [cwd] }));
        edges.add(
          new DynamicEdgeImpl(
            getSourceLocation(J$.iidToLocation(callerIID as IID)),
            // the 'to' source location is irrelevant when we're loading a module
            // since the soundness analysis only checks if the right file is loaded.
            {
              source: toBeLoadedModulePath,
              start: {
                line: 0,
                column: 0,
              },
              end: {
                line: 0,
                column: 0,
              },
            },
            true
          )
        );
      } catch (e) {}
      callerIID = undefined;
    }
  },

  functionEnter: function (iid: IID) {
    try {
      if (iid && callerIID) {
        let callerLocation = J$.iidToLocation(callerIID);
        let calleeLocation = J$.iidToLocation(iid);
        if (calleeLocation.includes('graceful-fs')) {
          // graceful-fs is used internally by Graal's require, so we have to filter those edges.
          // Notice, even tough 'require' is seen as an internal function by NodeProf that is not the case for its dependencies.
          return;
        }
        const internalCaller = callerLocation.startsWith('(*');
        const internalCallee = calleeLocation.startsWith('(*');
        callerIID = undefined;
        if (!internalCaller && !internalCallee) {
          // fixme do we always want to exclude calls to internal functions?
          const edge = new DynamicEdgeImpl(
            getSourceLocation(callerLocation),
            getSourceLocation(calleeLocation),
            false //nextCallModuleLoad
          );
          //nextCallModuleLoad = false;
          edges.add(edge);
        }
      }
    } catch (e) {
      console.log(`error during call edge construction: ${e}`);
    }
  },

  endExecution() {
    const outFile = J$.initParams.out;
    writeFileSync(outFile, JSON.stringify([...edges.values()], null, 2));
    console.log(`analysis output written to ${outFile}`);
  },
};
J$.analysis = analysis;
