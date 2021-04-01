import {
  AssignmentPattern,
  ArrayExpression,
  BlockStatement,
  CallExpression,
  ExportNamedDeclaration,
  ExpressionStatement,
  FunctionExpression,
  FunctionDeclaration,
  Identifier,
  ImportSpecifier,
  ImportDeclaration,
  MemberExpression,
  NewExpression,
  ObjectExpression,
  ObjectPattern,
  SimpleCallExpression,
  SimpleLiteral,
  ThisExpression,
  ArrowFunctionExpression,
  AssignmentExpression,
  SpreadElement,
  Program,
  Property,
  TemplateLiteral,
  VariableDeclarator,
  BaseFunction,
  LogicalExpression,
  ConditionalExpression,
  VariableDeclaration,
  BinaryExpression,
  ClassDeclaration,
} from 'estree';

/**
 * Represents both constructor and non-constructor calls
 * @param expr
 */
export function isCallExpression(expr: any): expr is CallExpression {
  return isSimpleCallExpression(expr) || isNewExpression(expr);
}

/**
 * Represents all constructor calls
 * @param expr
 */
export function isNewExpression(expr: any): expr is NewExpression {
  return expr && expr.type === 'NewExpression';
}

/**
 * Represents all non-constructor calls
 * @param expr
 */
export function isSimpleCallExpression(expr: any): expr is SimpleCallExpression {
  return expr && expr.type === 'CallExpression';
}

/**
 * Represents property reads
 * @param node
 */
export function isMemberExpression(node: any): node is MemberExpression {
  return node && node.type === 'MemberExpression';
}

export function isAssignmentExpression(node: any): node is AssignmentExpression {
  return node && node.type === 'AssignmentExpression';
}

/**
 * Represents identifier nodes, e.g., 'o' and 'p' in o.p
 * @param node
 */
export function isIdentifier(node: any): node is Identifier {
  return node && node.type === 'Identifier';
}

export function isImportSpecifier(node: any): node is ImportSpecifier {
  return node && node.type === 'ImportSpecifier';
}

export function isImportDefaultSpecifier(node: any): node is ImportSpecifier {
  return node && node.type === 'ImportDefaultSpecifier';
}

export function isImportNamespaceSpecifier(node: any): node is ImportSpecifier {
  return node && node.type === 'ImportNamespaceSpecifier';
}

/**
 * returns true if node represents a non-regex literal
 * @param node
 */
export function isSimpleLiteral(node: any): node is SimpleLiteral {
  return node && node.type === 'Literal' && node.regex == undefined;
}

export function isFunctionExpression(node: any): node is FunctionExpression {
  return node && node.type === 'FunctionExpression';
}

export function isArrowFunctionExpression(node: any): node is ArrowFunctionExpression {
  return node && node.type === 'ArrowFunctionExpression';
}

export function isFunctionDeclaration(node: any): node is FunctionDeclaration {
  return node && node.type === 'FunctionDeclaration';
}

export function isAnyCreateFunctionNode(node: any): node is BaseFunction {
  return isFunctionExpression(node) || isArrowFunctionExpression(node) || isFunctionDeclaration(node);
}

export function isObjectExpression(node: any): node is ObjectExpression {
  return node && node.type === 'ObjectExpression';
}

export function isArrayExpression(node: any): node is ArrayExpression {
  return node && node.type === 'ArrayExpression';
}

export function isTemplateLiteral(node: any): node is TemplateLiteral {
  return node && node.type === 'TemplateLiteral';
}

export function isObjectPattern(node: any): node is ObjectPattern {
  return node && node.type === 'ObjectPattern';
}

export function isSpreadElement(node: any): node is SpreadElement {
  return node && node.type === 'SpreadElement';
}

export function isImportDeclaration(node: any): node is ImportDeclaration {
  return node && node.type === 'ImportDeclaration';
}

export function isProperty(node: any): node is Property {
  return node && node.type === 'Property';
}

export function isRequireCall(node: any, requireAliases: Set<string>): node is SimpleCallExpression {
  return (
    isSimpleCallExpression(node) &&
    isIdentifier(node.callee) &&
    (node.callee.name === 'require' || requireAliases.has(node.callee.name)) &&
    node.arguments.length === 1
  );
}

export function isModuleImport(n: any, requireAliases: Set<string>): boolean {
  return (
    isRequireCall(n, requireAliases) ||
    isImportDefaultSpecifier(n) ||
    isImportNamespaceSpecifier(n) ||
    isImportSpecifier(n) ||
    isImportDeclaration(n)
  );
}

export function isExpressionStatement(node: any): node is ExpressionStatement {
  return node && node.type === 'ExpressionStatement';
}

export function isVariableDeclarator(node: any): node is VariableDeclarator {
  return node && node.type === 'VariableDeclarator';
}

export function isVariableDeclaration(node: any): node is VariableDeclaration {
  return node && node.type === 'VariableDeclaration';
}

export function isProgram(node: any): node is Program {
  return node && node.type === 'Program';
}

export function isBlockStatement(node: any): node is BlockStatement {
  return node && node.type === 'BlockStatement';
}

export function isExportNamedDeclaration(node: any): node is ExportNamedDeclaration {
  return node && node.type === 'ExportNamedDeclaration';
}

export function isParenthesizedExpression(node: any) {
  return node && node.type === 'ParenthesizedExpression';
}

export function isAssignmentPattern(node: any): node is AssignmentPattern {
  return node && node.type === 'AssignmentPattern';
}

export function isThisExpression(node: any): node is ThisExpression {
  return node && node.type === 'ThisExpression';
}

export function isNegationExpression(node: any): boolean {
  return node && node.type === 'UnaryExpression' && node.operator === '!';
}

export function isLogicalExpression(node: any): node is LogicalExpression {
  return node && node.type === 'LogicalExpression';
}

export function isConditionalExpression(node: any): node is ConditionalExpression {
  return node && node.type === 'ConditionalExpression';
}

export function isBinaryExpression(node: any): node is BinaryExpression {
  return node && node.type === 'BinaryExpression';
}

export function isClassDeclaration(node: any): node is ClassDeclaration {
  return node && node.type === 'ClassDeclaration';
}
