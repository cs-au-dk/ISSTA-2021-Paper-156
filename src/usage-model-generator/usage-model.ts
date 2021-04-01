import { AccessPath, FunctionCreation, ImportAccessPath } from './access-path';
import { addAllToMapSet, MapWithToStringEquality, SetWithToStringEquality } from '../util/collections';
import { SourceLocation } from 'estree';

export class UsageModel {
  readonly exportsSummary: Map<string, Set<FunctionCreation | ImportAccessPath>>;
  readonly functionUsageSummaries: MapWithToStringEquality<
    FunctionCreation | ImportAccessPath,
    SetWithToStringEquality<AccessPath>
  >;
  readonly functionReturnSummaries: MapWithToStringEquality<AccessPath, SetWithToStringEquality<AccessPath>>;
  readonly fieldBasedSummary: Map<string, SetWithToStringEquality<AccessPath>>;
  readonly fieldBasedSummaryWithWildcards: Map<string, SetWithToStringEquality<AccessPath>>;
  readonly gettersSummary: Map<string, SetWithToStringEquality<AccessPath>>;
  readonly eventListenerSummary: Map<string, SetWithToStringEquality<AccessPath>>;

  constructor(
    exportsSummary: Map<string, Set<FunctionCreation | ImportAccessPath>>,
    functionUsageSummaries: MapWithToStringEquality<
      FunctionCreation | ImportAccessPath,
      SetWithToStringEquality<AccessPath>
    >,
    functionReturnSummaries: MapWithToStringEquality<AccessPath, SetWithToStringEquality<AccessPath>>,
    fieldBasedSummary: Map<string, SetWithToStringEquality<AccessPath>>,
    fieldBasedSummaryWithWildcards: Map<string, SetWithToStringEquality<AccessPath>>,
    gettersSummary: Map<string, SetWithToStringEquality<AccessPath>>,
    eventListenerSummary: Map<string, SetWithToStringEquality<AccessPath>>
  ) {
    this.exportsSummary = exportsSummary;
    this.functionUsageSummaries = functionUsageSummaries;
    this.functionReturnSummaries = functionReturnSummaries;
    this.fieldBasedSummary = fieldBasedSummary;
    this.fieldBasedSummaryWithWildcards = fieldBasedSummaryWithWildcards;
    this.gettersSummary = gettersSummary;
    this.eventListenerSummary = eventListenerSummary;
  }

  public writeSummary() {
    const exportsSummaryTransformed: Map<string, Set<string>> = new Map();
    this.exportsSummary.forEach((accPaths, propName) =>
      addAllToMapSet(exportsSummaryTransformed, propName, new Set([...accPaths].map((accPath) => accPath.toString())))
    );
    const functionUsageSummariesTransformed: Map<string, Set<string>> = new Map();
    this.functionUsageSummaries.forEach((accPaths, key) =>
      addAllToMapSet(
        functionUsageSummariesTransformed,
        key.toString(),
        new Set([...accPaths].map((accPath) => accPath.toString()))
      )
    );
    const functionReturnSummariesTransformed: Map<string, Set<string>> = new Map();
    this.functionReturnSummaries.forEach((accPaths, key) =>
      addAllToMapSet(
        functionReturnSummariesTransformed,
        key.toString(),
        new Set([...accPaths].map((accPath) => accPath.toString()))
      )
    );

    const usageModelObject: any = { exportsSummary: {}, functionUsageSummaries: {}, functionReturnSummaries: {} };
    exportsSummaryTransformed.forEach(
      (accPaths, propName) => (usageModelObject.exportsSummary[propName] = [...accPaths])
    );
    functionUsageSummariesTransformed.forEach(
      (accPaths, propName) => (usageModelObject.functionUsageSummaries[propName] = [...accPaths])
    );
    functionReturnSummariesTransformed.forEach(
      (accPaths, propName) => (usageModelObject.functionReturnSummaries[propName] = [...accPaths])
    );

    console.log(JSON.stringify(usageModelObject, null, 2));
  }
}

export type PackageModel = { [index: string]: SourceLocation | string };
