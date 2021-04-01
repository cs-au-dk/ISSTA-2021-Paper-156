import { DynamicCallEdge } from './soundness-tester';
import { sourceLocationToString } from '../usage-model-generator/compute-call-graph';
import { SourceLocation } from 'estree';

const knownUnsoundnesses: Set<string> = new Set();
const knownMissingNodes: Set<string> = new Set();

export function stringifyDynamicCallEdge(callEdge: DynamicCallEdge) {
  return `${sourceLocationToString(callEdge.from)}->${sourceLocationToString(callEdge.to)}`;
}

export function isKnownUnsoundness(calledge: DynamicCallEdge) {
  return knownUnsoundnesses.has(stringifyDynamicCallEdge(calledge));
}

export function isKnownMissingNode(sourceLocation: SourceLocation) {
  return knownMissingNodes.has(sourceLocationToString(sourceLocation));
}

function addUnsoundnessesDueToMissingNativeModelling() {
  [
    // Missing forEach modelling
    'res/library-load-benchmarks/lodash/lodash.js:1403:4:1405:6->res/library-load-benchmarks/lodash/lodash.js:1403:16:1405:5',

    // Missing map modelling
    'res/library-load-benchmarks/bluebird/js/release/join.js:48:10:60:14->res/library-load-benchmarks/bluebird/js/release/join.js:49:17:60:13',

    // Missing Promise constructor modelling
    'res/library-load-benchmarks/bluebird/js/release/util.js:319:20:319:47->res/library-load-benchmarks/bluebird/js/release/util.js:319:32:319:46',
  ].forEach((unsoundString) => knownUnsoundnesses.add(unsoundString));
}
function addUnsoundnessesDueToDynamicallyGeneratedCode() {
  [
    // call graph nodes generated by eval or new Function
    'eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):3:7:46:45',
    'eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):3:7:52:45',
    'eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):3:7:58:45',
    'eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):3:7:64:45',
    'eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):3:7:70:45',
    'eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):3:7:76:45',
    'eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):3:7:82:45',
    'eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):3:7:88:45',
  ].forEach((unsoundString) => knownMissingNodes.add(unsoundString));

  [
    // call edges to nodes defined in an eval or new Function call
    'res/library-load-benchmarks/bluebird/js/release/join.js:12:15:23:9->eval at thenCallback (./res/library-load-benchmarks/bluebird/js/release/join.js:12:16):1:0:8:2',
    'res/library-load-benchmarks/bluebird/js/release/join.js:27:15:37:9->eval at promiseSetter (./res/library-load-benchmarks/bluebird/js/release/join.js:27:16):1:0:7:2',

    'res/library-load-benchmarks/bluebird/js/release/join.js:113:15:113:113->eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):1:1:48:1',
    'res/library-load-benchmarks/bluebird/js/release/join.js:113:15:113:113->eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):1:1:54:1',
    'res/library-load-benchmarks/bluebird/js/release/join.js:113:15:113:113->eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):1:1:60:1',
    'res/library-load-benchmarks/bluebird/js/release/join.js:113:15:113:113->eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):1:1:66:1',
    'res/library-load-benchmarks/bluebird/js/release/join.js:113:15:113:113->eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):1:1:72:1',
    'res/library-load-benchmarks/bluebird/js/release/join.js:113:15:113:113->eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):1:1:78:1',
    'res/library-load-benchmarks/bluebird/js/release/join.js:113:15:113:113->eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):1:1:84:1',
    'res/library-load-benchmarks/bluebird/js/release/join.js:113:15:113:113->eval at generateHolderClass (./res/library-load-benchmarks/bluebird/js/release/join.js:113:16):1:1:90:1',
  ].forEach((unsoundString) => knownUnsoundnesses.add(unsoundString));
}

addUnsoundnessesDueToMissingNativeModelling();
addUnsoundnessesDueToDynamicallyGeneratedCode();
