export interface IllegalLoad {
  loadedFile: string;
  loadedFromFile: string;
  // the actual string passed to require.
  moduleName: string;
}
