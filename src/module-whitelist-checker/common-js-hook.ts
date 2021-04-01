import Module = require('module');

// @ts-ignore
import originalRequire = Module.prototype.require;
import { checkLoad } from './util';
import { dirname } from 'path';

//@ts-ignore
Module.prototype.require = function (name: string) {
  let modulePath = undefined;
  try {
    modulePath = require.resolve(name, { paths: [dirname(this.filename)] });
  } catch (e) {
    console.log(`require.resolve of ${name} failed with ${e}`);
  }
  if (modulePath) {
    checkLoad(modulePath, name, this.filename);
  }
  return originalRequire.apply(this, arguments);
};
