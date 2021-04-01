export type IID = number;

export type GIID = string;

export interface SourceCodePointer {
  line: number;
  column: number;
}

export interface CodeSnippetLocation {
  start: SourceCodePointer;
  end: SourceCodePointer;
}

export interface Jalangi {

  smap: { [key: number]: any };

  initParams?: any;

  sid: IID;

  getGlobalIID(iid: IID): GIID;

  iidToLocation(iid: IID): string;

  iidToSourceObject(iid: GIID):
    {name: string, loc: CodeSnippetLocation, range: []};

  analysis?: JalangiAnalysis;

  smemory?: {

    getShadowObject(
      obj: object,
      prop: string,
      isGetField: boolean
    ): { owner: object, isProperty: boolean };

    getShadowFrame(name: string): object;

    getIDFromShadowObjectOrFrame(obj: object): number | void;

    getActualObjectOrFunctionFromShadowObjectOrFrame(obj: object): any;

    getFrame(name: string): object;

    getShadowObjectOfObject(val: object): object | void;

  };

}

export interface JalangiAnalysis {

  invokeFunPre?(
    iid: IID,
    f: Function,
    base: object,
    args: any[],
    isConstructor: boolean,
    isMethod: boolean,
    functionIid: IID,
    functionSid: IID
  ): { f: Function, base: object, args: any[], skip: boolean } | void;

  invokeFun?(
    iid: IID,
    f: Function,
    base: any,
    args: any[],
    result: any,
    isConstructor: boolean,
    isMethod: boolean,
    functionIid: IID,
    functionSid: IID
  ): { result: any } | void;

  literal?(
    iid: IID,
    val: any,
    hasGetterSetter: boolean
  ): { result: any } | void;

  forinObject?(
    iid: IID,
    val: any
  ): { result: any } | void;

  declare?(
    iid: IID,
    name: string,
    val: any,
    isArgument: boolean,
    argumentIndex: number,
    isCatchParam: boolean
  ): { result: any } | void;

  getFieldPre?(
    iid: IID,
    base: any,
    offset: string | any,
    isComputed: boolean,
    isOpAssign: boolean,
    isMethodCall: boolean
  ): { base: any, offset: any, skip: boolean } | void;

  getField?(
    iid: IID,
    base: any,
    offset: string | any,
    val: any,
    isComputed: boolean,
    isOpAssign: boolean,
    isMethodCall: boolean
  ): { result: any } | void;

  putFieldPre?(
    iid: IID,
    base: any,
    offset: string | any,
    val: any,
    isComputed: boolean,
    isOpAssign: boolean
  ): { base: any, offset: any, val: any, skip: boolean } | void;

  putField?(
    iid: IID,
    base: any,
    offset: string | any,
    val: any,
    isComputed: boolean,
    isOpAssign: boolean
  ): { result: any } | void;

  read?(
    iid: IID,
    name: string,
    val: any,
    isGlobal: boolean,
    isScriptLocal: boolean,
  ): { result: any } | void;

  write?(
    iid: IID,
    name: string,
    val: any,
    lhs: any,
    isGlobal: any,
    isScriptLocal: any
  ): { result: any } | void;

  _return?(
    iid: IID,
    val: any
  ): { result: any } | void;

  _throw?(
    iid: IID,
    val: any
  ): { result: any } | void;

  _with?(
    iid: IID,
    val: any
  ): { result: any } | void;

  functionEnter?(
    iid: IID,
    f: Function,
    dis: any,
    args: any[]
  ): void;

  functionExit?(
    iid: IID,
    returnVal: any,
    wrappedExceptionVal: { exception: any } | undefined
  ): { returnVal: any, wrappedExceptionVal: any, isBacktrack: boolean } | void;

  scriptEnter?(
    iid: IID,
    instrumentedFileName: string,
    originalFileName: string
  ): void;

  scriptExit?(
    iid: IID,
    wrappedExceptionVal: { exception: any } | undefined
  ): { returnVal: any, wrappedExceptionVal: any, isBacktrack: boolean } | void;

  binaryPre?(
    iid: IID,
    op: string,
    left: any,
    right: any,
    isOpAssign: boolean,
    isSwitchCaseComparison: boolean,
    isComputed: boolean
  ): { op: string, left: any, right: any, skip: boolean } | void;

  binary?(
    iid: IID,
    op: string,
    left: any,
    right: any,
    result: any,
    isOpAssign: boolean,
    isSwitchCaseComparison: boolean,
    isComputed: boolean
  ): { result: any } | void;

  unaryPre?(
    iid: IID,
    op: string,
    left: any
  ): { op: string, left: any, skip: boolean } | void;

  unary?(
    iid: IID,
    op: string,
    left: any,
    result: any
  ): { result: any } | void;

  conditional?(
    iid: IID,
    result: any
  ): { result: any } | void;

  instrumentCodePre?(
    iid: IID,
    code: any,
    isDirect: boolean
  ): { code: any, skip: boolean } | void;

  instrumentCode?(
    iid: IID,
    newCode: any,
    newAst: object,
    isDirect: boolean
  ): { result: any } | void;

  endExpression?(iid: IID): void;

  endExecution?(): void;

  runInstrumentedFunctionBody?(
    iid: IID,
    f: Function,
    functionIid: IID,
    functionSid: IID
  ): boolean;

  onReady?(cb: Function): void;

}
