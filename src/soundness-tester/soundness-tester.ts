import { StaticConfiguration } from '../static-configuration';
import { basename, resolve } from 'path';
import { createDirectoryIfMissing, fileExists, readDir } from '../util/file';
import { runAnalysis } from '../node-prof-analyses/analysis';
import * as fs from 'fs';
import {
  CallGraph,
  ResolvedCallGraphNode,
  SimpleCallGraph,
  inFileSourceLocationToStringOnlyLines,
  //UnknownCallGraphNode,
  UnresolvedCallGraphNode,
  sourceLocationToString,
  inFileSourceLocationToString,
} from '../usage-model-generator/compute-call-graph';
import { some } from 'lodash';
import { FunctionCreation, ModuleMainPath } from '../usage-model-generator/access-path';
import { createLogger } from '../logging';
import { isKnownMissingNode, isKnownUnsoundness } from './known-unsoundnesses';
import { SourceLocation } from 'estree';
import { addToMapSetWithStringEquality, SetWithToStringEquality } from '../util/collections';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const logger = createLogger('soundness-tester', 'info');

export async function soundnessTestPreloaded(
  cg: CallGraph | SimpleCallGraph,
  soundnessEdges: DynamicCallEdge[],
  ignoredModules: string[]
) {
  const sourceSLToTargetMap = new Map();
  [...cg.sourceSLToEdgeMap.entries()].forEach(([k, v]) => {
    v.forEach((e) => {
      cg.edgeToTargets.get(e)?.forEach((target) => {
        addToMapSetWithStringEquality(sourceSLToTargetMap, k, target);
      });
    });
  });
  return await actuallyDoSoundnessTest(sourceSLToTargetMap, soundnessEdges, ignoredModules);
}

function matchesDueToLocationsDifferentInStaticAndDynamicAnalysis(
  targetSL: string,
  functionCreation: FunctionCreation
) {
  const validMatches = [
    {
      targetSL: '14:284',
      file: './out/client-fetch/jwtnoneify@1.0.1/package/node_modules/caporal/lib/program.js',
      locationString: '16:13:30:3',
    },
    {
      targetSL: '11:157',
      file: './out/client-fetch/jwtnoneify@1.0.1/package/node_modules/caporal/lib/help.js',
      locationString: '13:13:16:3',
    },
    {
      targetSL: '8:217',
      file: './out/client-fetch/jwtnoneify@1.0.1/package/node_modules/caporal/lib/autocomplete.js',
      locationString: '10:13:17:3',
    },
    {
      targetSL: '17:456',
      file: './out/client-fetch/jwtnoneify@1.0.1/package/node_modules/caporal/lib/command.js',
      locationString: '25:13:38:3',
    },
    {
      targetSL: '6:60',
      file: './out/client-fetch/jwtnoneify@1.0.1/package/node_modules/caporal/lib/argument.js',
      locationString: '16:13:28:3',
    },
    {
      targetSL: '9:20',
      file: './out/client-fetch/jwtnoneify@1.0.1/package/node_modules/caporal/lib/error/unknown-option.js',
      locationString: '10:13:19:3',
    },
  ];
  // dynamic analysis uses entire class body as source location for a class, while the static analysis uses the constructor function
  return validMatches.some(
    (validMatch) =>
      validMatch.targetSL === targetSL &&
      validMatch.file === functionCreation.file &&
      validMatch.locationString === inFileSourceLocationToString(functionCreation.sourceLocation)
  );
}

export async function actuallyDoSoundnessTest(
  sourceSlToTargetMap: Map<string, SetWithToStringEquality<ResolvedCallGraphNode>>,
  soundnessEdges: DynamicCallEdge[],
  ignoredModules: string[]
) {
  let ignoredModuleEdges = 0,
    unresolvedNodeEdges = 0,
    correctEdges = 0,
    unknownTargetEdges = 0,
    missingSourceNodeEdge = 0,
    expectedMissingSourceNodeEdge = 0,
    expectedPresentSourceNodeEdgeToBeMissing = 0,
    missingLoadDestEdge = 0,
    missingNonLoadDestEdge = 0,
    expectedUnsoundEdges = 0,
    unexpectedSoundEdges = 0,
    unsoundEdgesIgnoringEsprima = 0;

  for (const edge of soundnessEdges) {
    if (
      edge.from.source?.includes('node-prof-analyses/runner.js') ||
      edge.to.source?.startsWith('dist/util/collections.js') ||
      edge.from.source?.startsWith('node_modules/') ||
      edge.to.source?.startsWith('node_modules/') ||
      isInvalidEdge(edge)
    )
      continue;
    // ignore edges coming from ignored modules or going to ignored modules.
    if (
      some(ignoredModules, (im) => (edge.from.source as string).includes(im) || (edge.to.source as string).includes(im))
    ) {
      ignoredModuleEdges++;
      continue;
    }
    const sourceSL = stringifySourceLocation(edge.from);
    if (!sourceSlToTargetMap.has(sourceSL)) {
      if (isKnownMissingNode(edge.from)) {
        expectedMissingSourceNodeEdge++;
      } else {
        missingSourceNodeEdge++;
        if (!edge.from.source?.includes('dist/esprima.js') && !edge.to.source?.includes('dist/esprima.js'))
          unsoundEdgesIgnoringEsprima++;
        logger.warn(`Soundness error. CallGraph is missing node at ${edge.from.source as string}:${sourceSL}`);
      }
      continue;
    } else if (isKnownMissingNode(edge.from)) {
      expectedPresentSourceNodeEdgeToBeMissing++;
    }
    const cgTargets = [
      ...(sourceSlToTargetMap.get(sourceSL) as SetWithToStringEquality<ResolvedCallGraphNode>).values(),
    ];
    // avoid checking from nodes that are connected to an unresolved node
    if (some(cgTargets, (target) => target instanceof UnresolvedCallGraphNode)) {
      unresolvedNodeEdges++;
      continue;
    }
    const targetSL = patchAndStringifySourceLocationForEdge(edge);
    if (
      edge.isLoad &&
      !some(
        cgTargets,
        (target) =>
          target instanceof ResolvedCallGraphNode &&
          target.node instanceof ModuleMainPath &&
          (target.node.fileLocation.includes(edge.to.source as string) ||
            (edge.to.source?.startsWith('../') && target.node.fileLocation.includes(edge.to.source?.substring(3))) ||
            isLoadPathWronglyComputedInCallGraphAnalysis(edge.to, target))
      )
    ) {
      if (isKnownUnsoundness(edge)) {
        expectedUnsoundEdges++;
      } else {
        missingLoadDestEdge++;
        logger.warn(
          `Soundness error: Expected ${sourceLocationToString(edge.from)} to have a module load edge to file ${
            edge.to.source as string
          }`
        );
      }
    } else if (
      !edge.isLoad &&
      !some(
        cgTargets,
        (target) =>
          target instanceof ResolvedCallGraphNode &&
          target.node instanceof FunctionCreation &&
          // fixme: check that the target is in the right file as well.
          (targetSL === inFileSourceLocationToStringOnlyLines(target.node.sourceLocation) ||
            (targetSL && matchesDueToLocationsDifferentInStaticAndDynamicAnalysis(targetSL, target.node)))
      )
    ) {
      if (isKnownUnsoundness(edge)) {
        expectedUnsoundEdges++;
      } /*else if (some(cgTargets, (target) => target instanceof UnknownCallGraphNode)) {
        unknownTargetEdges++;
      } */ else {
        missingNonLoadDestEdge++;
        if (!edge.from.source?.includes('dist/esprima.js') && !edge.to.source?.includes('dist/esprima.js'))
          unsoundEdgesIgnoringEsprima++;
        logger.warn(
          `Soundness error: Expected ${sourceLocationToString(edge.from)} to have an edge to ${sourceLocationToString(
            edge.to
          )}`
        );
      }
    } else {
      if (isKnownUnsoundness(edge)) {
        unexpectedSoundEdges++;
        logger.warn(
          `Expected soundness error, but did find an edge from ${sourceLocationToString(
            edge.from
          )} to ${sourceLocationToString(edge.to)}`
        );
      }
      correctEdges++;
    }
  }
  const numberMissingEdges = missingNonLoadDestEdge + missingLoadDestEdge + missingSourceNodeEdge;
  logger.info(`Soundness test summary
total tested Edges: ${soundnessEdges.length}
sound edges: ${correctEdges + ignoredModuleEdges + unresolvedNodeEdges + unknownTargetEdges + unexpectedSoundEdges}
\t - expected correct edges: ${correctEdges}
\t - unexpected correct edges: ${unexpectedSoundEdges}
\t - ignored module edges: ${ignoredModuleEdges}
\t - unresolved node edges: ${unresolvedNodeEdges}
\t - unknown target edges: ${unknownTargetEdges}
\t - did not expect source node to be present: ${expectedPresentSourceNodeEdgeToBeMissing}
unexpected unsound edges: ${numberMissingEdges} (${
    expectedMissingSourceNodeEdge + expectedUnsoundEdges
  } expected missing edges)
\t - unexpected missing source nodes ${missingSourceNodeEdge}
\t - missing load edges ${missingLoadDestEdge}
\t - missing non-load edges ${missingNonLoadDestEdge}
\t - expected missing source nodes ${expectedMissingSourceNodeEdge}
\t - expected unsound edges ${expectedUnsoundEdges}`);
  return {
    soundEdges: correctEdges,
    missingEdges: numberMissingEdges,
    missingEdgesIgnoringEsprima: unsoundEdgesIgnoringEsprima,
  };
}

export async function soundnessTest(
  benchmarkGroupDir: string,
  clientFolder: string,
  entryFile: string,
  cg: CallGraph | SimpleCallGraph,
  ignoredModules: string[]
) {
  const soundnessEdges = await computeAndLoadDynamicCallEdges(benchmarkGroupDir, clientFolder, entryFile);
  return soundnessTestPreloaded(cg, soundnessEdges, ignoredModules);
}

export interface DynamicCallEdge {
  from: SourceLocation;
  to: SourceLocation;
  isLoad: boolean;
}

export class DynamicEdgeSet {
  private edges: Map<string, DynamicCallEdge> = new Map();

  insertEdge(d: DynamicCallEdge) {
    const key = `${stringifySourceLocation(d.from)}->${stringifySourceLocation(d.to)}`;
    if (!this.edges.has(key)) {
      this.edges.set(key, d);
    }
  }

  insertEdges(ds: DynamicCallEdge[]) {
    ds.forEach((d) => this.insertEdge(d));
  }

  getEdges(): DynamicCallEdge[] {
    return [...this.edges.values()];
  }
}

export function stringifySourceLocation(l: SourceLocation) {
  return `${l.start.line}:${l.end.line}`; //${l.beginColumn}:${l.endLine}:${l.endColumn}`;
}

export async function computeAndLoadDynamicCallEdges(
  benchmarkGroupDir: string,
  clientFolder: string,
  entryFile: string,
  extraParams: string | undefined = undefined
): Promise<DynamicCallEdge[]> {
  const soundnessOutFolder = resolve(StaticConfiguration.dynamicCallGraphPath, clientFolder);
  await createDirectoryIfMissing(soundnessOutFolder);
  let x = basename(entryFile);
  const soundnessFileName = `${x.substring(0, x.lastIndexOf('.'))}.json`;
  const soundnessFile = resolve(soundnessOutFolder, soundnessFileName);

  if (!(await fileExists(soundnessFile))) {
    await runAnalysis(
      'call-graph',
      resolve(benchmarkGroupDir, clientFolder, entryFile),
      soundnessFile,
      {},
      extraParams
    );
  }

  return await loadDynamicCallEdges(soundnessFile);
}

export async function loadDynamicCallEdges(path: string): Promise<DynamicCallEdge[]> {
  return JSON.parse(await fs.promises.readFile(path, 'utf-8')).filter(
    // ignore the edge from the analysis runner
    (e: DynamicCallEdge) => !(e.from.source as string).includes('runner') && !(e.to.source as string).includes('runner')
  );
}

export async function getDynamicEdgesUsingInputs(client: PotentialBenchmarkClient, clientMain: string) {
  const dynamicCallGraphFolder = resolve(StaticConfiguration.dynamicCallGraphPath, 'benchmarks', client.packageName);
  const dynamicCallGraphCombinedFile = resolve(dynamicCallGraphFolder, 'combined.json');
  if (!existsSync(dynamicCallGraphCombinedFile)) {
    const inputs = JSON.parse(readFileSync(StaticConfiguration.benchmarkInputs, { encoding: 'utf-8' }));
    const currentBenchmarkInputs: string[] = inputs[client.packageName];
    const currentBenchmarkResourcesFolder = resolve(StaticConfiguration.benchmarkResources, client.packageName);
    await createDirectoryIfMissing(dynamicCallGraphFolder);
    const combinedDynamicEdges = new DynamicEdgeSet();

    // read existing dynamic call graphs
    const existingDynamicGraphs = (await readDir(dynamicCallGraphFolder)).filter((file) => file.endsWith('.json'));
    for (let i = 0; i < existingDynamicGraphs.length; i++) {
      const edges: DynamicCallEdge[] = JSON.parse(
        readFileSync(resolve(dynamicCallGraphFolder, existingDynamicGraphs[i]), { encoding: 'utf-8' })
      );
      combinedDynamicEdges.insertEdges(edges);
    }

    // generate dynamic call graphs from the inputs in benchmark-inputs.json
    for (let i = 0; i < currentBenchmarkInputs.length; i++) {
      const input = currentBenchmarkInputs[i];
      const resolvedInput = input.replace('{RES}', currentBenchmarkResourcesFolder);
      const dynGraphFile = resolve(dynamicCallGraphFolder, `dyn_graph_input${i}.json`);
      await runAnalysis('call-graph', clientMain, dynGraphFile, {}, resolvedInput);
      combinedDynamicEdges.insertEdges(await loadDynamicCallEdges(dynGraphFile));
    }
    writeFileSync(dynamicCallGraphCombinedFile, JSON.stringify(combinedDynamicEdges.getEdges()), {
      encoding: 'utf-8',
    });
  }
  const soundnessEdges: DynamicCallEdge[] = JSON.parse(
    await readFileSync(dynamicCallGraphCombinedFile, { encoding: 'utf-8' })
  );
  return soundnessEdges;
}

function isInvalidEdge(edge: DynamicCallEdge) {
  return invalidEdges.has(`${sourceLocationToString(edge.from)}->${sourceLocationToString(edge.to)}`);
}
const invalidEdges = new Set([
  // a getter is called at a Object.keys().forEach call, but the object used in Object.keys does not have the getter
  'out/client-fetch/makeappicon@1.2.2/package/node_modules/yargs/index.js:565:8:599:10->out/client-fetch/makeappicon@1.2.2/package/node_modules/yargs/index.js:446:14:446:59',
  // The dynamic analysis mixes two forEach calls together
  'out/client-fetch/smrti@1.0.3/package/node_modules/yargs/lib/obj-filter.js:5:2:9:4->out/client-fetch/smrti@1.0.3/package/node_modules/yargs/yargs.js:122:26:124:5',
  // A function call in the callback to a forEach has an edge to the callback itself
  'out/client-fetch/smrti@1.0.3/package/node_modules/yargs/index.js:27:6:27:60->out/client-fetch/smrti@1.0.3/package/node_modules/yargs/index.js:25:28:31:3',
  // The source for one forEach call is the target for another
  'out/client-fetch/smrti@1.0.3/package/node_modules/yargs-parser/index.js:710:8:714:10->out/client-fetch/smrti@1.0.3/package/node_modules/yargs-parser/index.js:683:37:715:7',
  'out/client-fetch/smrti@1.0.3/package/node_modules/yargs-parser/index.js:710:8:714:10->out/client-fetch/smrti@1.0.3/package/node_modules/yargs-parser/index.js:682:50:716:5',
  'out/client-fetch/smrti@1.0.3/package/node_modules/yargs-parser/index.js:683:6:715:8->out/client-fetch/smrti@1.0.3/package/node_modules/yargs-parser/index.js:682:50:716:5',

  'out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/lib/obj-filter.js:5:2:9:4->out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/yargs.js:122:26:124:5',
  'out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/index.js:27:6:27:60->out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/index.js:25:28:31:3',
  'out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs-parser/index.js:710:8:714:10->out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs-parser/index.js:683:37:715:7',
  'out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs-parser/index.js:710:8:714:10->out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs-parser/index.js:682:50:716:5',
  'out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs-parser/index.js:683:6:715:8->out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs-parser/index.js:682:50:716:5',

  '/home/torp/development/dependency-graph-npm/out/client-fetch/npm-git-snapshot@0.1.1/package/node_modules/end-of-stream/index.js:76:1:76:28->/home/torp/development/dependency-graph-npm/out/client-fetch/npm-git-snapshot@0.1.1/package/node_modules/pump/index.js:65:29:75:3',
  '/home/torp/development/dependency-graph-npm/out/client-fetch/npm-git-snapshot@0.1.1/package/node_modules/pump/index.js:54:9:54:22->/home/torp/development/dependency-graph-npm/out/client-fetch/npm-git-snapshot@0.1.1/package/node_modules/bubble-stream-error/index.js:14:16:22:5',
  '/home/torp/development/dependency-graph-npm/out/client-fetch/npm-git-snapshot@0.1.1/package/node_modules/pump/index.js:54:9:54:22->/home/torp/development/dependency-graph-npm/out/client-fetch/npm-git-snapshot@0.1.1/package/node_modules/split-transform-stream/node_modules/readable-stream/lib/_stream_readable.js:740:24:760:1',

  'out/client-fetch/foxx-framework@0.3.6/package/node_modules/yargs/lib/obj-filter.js:4:2:8:4->out/client-fetch/foxx-framework@0.3.6/package/node_modules/yargs/yargs.js:108:26:112:5',
  'out/client-fetch/foxx-framework@0.3.6/package/node_modules/yargs/index.js:26:6:26:60->out/client-fetch/foxx-framework@0.3.6/package/node_modules/yargs/yargs.js:664:9:674:5',
  'out/client-fetch/foxx-framework@0.3.6/package/node_modules/yargs-parser/index.js:566:6:586:8->out/client-fetch/foxx-framework@0.3.6/package/node_modules/yargs-parser/index.js:565:50:587:5',
  'out/client-fetch/foxx-framework@0.3.6/package/node_modules/colors/lib/extendStringPrototype.js:8:4:8:50->out/client-fetch/foxx-framework@0.3.6/package/node_modules/colors/lib/extendStringPrototype.js:47:12:51:3',

  'out/client-fetch/npmgenerate@0.0.1/package/node_modules/chalk/index.js:31:14:42:14->out/client-fetch/npmgenerate@0.0.1/package/node_modules/chalk/index.js:15:8:18:4',
]);

const patchLocationMap: Map<string, string> = new Map([
  // The following patches are due to the dynamic analysis issues source locations for an arrow expression to end on the first column of the next line if single line, and if comments are following the arrow expression then they are treated as belonging to the function
  ['out/client-fetch/smrti@1.0.3/package/node_modules/yargs/lib/usage.js:146:25:147:1', '146:146'],
  ['out/client-fetch/smrti@1.0.3/package/node_modules/yargs/lib/command.js:162:21:163:1', '162:162'],
  ['out/client-fetch/smrti@1.0.3/package/node_modules/yargs/lib/command.js:166:27:167:1', '166:166'],
  ['out/client-fetch/smrti@1.0.3/package/node_modules/yargs/yargs.js:976:28:978:47', '976:976'],
  ['out/client-fetch/smrti@1.0.3/package/node_modules/yargs/yargs.js:688:20:689:1', '688:688'],
  ['out/client-fetch/smrti@1.0.3/package/node_modules/yargs/yargs.js:743:19:746:56', '743:743'],
  ['out/client-fetch/smrti@1.0.3/package/node_modules/yargs/yargs.js:575:27:576:1', '575:575'],
  ['out/client-fetch/smrti@1.0.3/package/node_modules/yargs/yargs.js:69:20:73:21', '69:69'],
  ['out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/lib/usage.js:146:25:147:1', '146:146'],
  ['out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/lib/command.js:162:21:163:1', '162:162'],
  ['out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/yargs.js:69:20:73:21', '69:69'],
  ['out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/yargs.js:688:20:689:1', '688:688'],
  ['out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/lib/command.js:166:27:167:1', '166:166'],
  ['out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/yargs.js:976:28:978:47', '976:976'],
  ['out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/yargs.js:743:19:746:56', '743:743'],
  ['out/client-fetch/ragan-module@1.3.0/package/node_modules/yargs/yargs.js:575:27:576:1', '575:575'],
]);
function patchAndStringifySourceLocationForEdge(edge: DynamicCallEdge) {
  const sourceLoc = sourceLocationToString(edge.to);
  if (patchLocationMap.has(sourceLoc)) return patchLocationMap.get(sourceLoc);

  return stringifySourceLocation(edge.to);
}
const invalidLoadTargetMap: Map<string, string> = new Map([
  ['<out/client-fetch/nodetree@0.0.3/package/node_modules/lodash/dist/lodash.js>', 'node_modules/lodash/lodash.js'],
  ['<out/client-fetch/openbadges-issuer@0.4.0/package/node_modules/chalk/index.js>', '../node_modules/chalk/index.js'],
  [
    '<out/client-fetch/openbadges-issuer@0.4.0/package/node_modules/ansi-styles/ansi-styles.js>',
    '../node_modules/ansi-styles/index.js',
  ],
  [
    '<out/client-fetch/openbadges-issuer@0.4.0/package/node_modules/lodash/dist/lodash.js>',
    '../node_modules/lodash/lodash.js',
  ],
  ['<out/client-fetch/jwtnoneify@1.0.1/package/node_modules/lodash/index.js>', 'node_modules/lodash/lodash.js'],
]);
function isLoadPathWronglyComputedInCallGraphAnalysis(loadLocation: SourceLocation, target: ResolvedCallGraphNode) {
  return invalidLoadTargetMap.get(target.toString()) === loadLocation.source;
}

export interface PotentialBenchmarkClient {
  packageName: string;
  packageVersion: string;
  bin: string;
  TPAdvisoryIds?: number[];
  FPAdvisoryIds?: number[];
  devDependencyAdvisoryOnly?: number[];
}
