const dataToLatex = require('data-to-latex');

export function constructLatexTable(table: (string | number)[][]): string {
  let latexTable: (string | number)[] = [];

  const tabularOptions = {
    vLines: new Array(table[0].length + 1).fill(true), // set vertical lines to get a fully closed tabular
    hLines: new Array(table.length + 1).fill(true), // set horizontal lines to close it horizontally
  };

  table.forEach((row) => (latexTable = latexTable.concat(row)));
  return dataToLatex
    .formattedTabular(latexTable, table[0].length, tabularOptions)
    .toString()
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/#/g, '\\#');
}
