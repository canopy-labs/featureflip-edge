// Loads one module in a fresh Node process and prints, as JSON, everything
// observable that loading it did: globals added or replaced, built-in
// prototypes patched, timers scheduled, and event listeners registered.
// `"sideEffects": false` in package.json promises bundlers that all four lists
// stay empty for every shipped file, so the package's tests run this against
// each one (#3562). The four JavaScript SDKs carry identical copies, since each
// is mirrored to its own public repo. Node itself leaves a trace or two on globalThis
// (an undici dispatcher symbol, for one), so callers compare against the
// report for an empty module rather than against empty lists.
//
// Usage: node import-probe.mjs <absolute path to .js/.mjs/.cjs | data: URL>
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
const report = { globals: [], patched: [], timers: [], listeners: [] };
const realSetTimeout = globalThis.setTimeout;

for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask']) {
  const real = globalThis[name];
  globalThis[name] = function (...args) {
    report.timers.push(name);
    return real.apply(this, args);
  };
}

const recordListeners = (owner, obj, methods) => {
  for (const method of methods) {
    const real = obj[method];
    obj[method] = function (type, ...rest) {
      report.listeners.push(`${owner}.${method}(${String(type)})`);
      return real?.call(this, type, ...rest);
    };
  }
};
// Stand-ins for the browser globals a module might attach to at load time.
// Nothing inspects them beyond the listener calls.
globalThis.window = {};
globalThis.document = {};
recordListeners('window', globalThis.window, ['addEventListener']);
recordListeners('document', globalThis.document, ['addEventListener']);
recordListeners('EventTarget', EventTarget.prototype, ['addEventListener']);
recordListeners('process', process, ['on', 'once', 'addListener', 'prependListener']);

const builtIns = {
  Object, Array, Function, String, Number, Boolean, Symbol, BigInt, Promise,
  Map, Set, WeakMap, WeakSet, Date, RegExp, Error, JSON, Math, Reflect,
  ArrayBuffer, Uint8Array, Uint32Array, TextEncoder, TextDecoder, URL,
};
// Descriptors are compared, never read through, so lazy getters on globalThis
// are not triggered by the probe itself.
const snapshot = () => {
  const entries = new Map();
  const add = (label, obj) => {
    for (const key of Reflect.ownKeys(obj)) {
      const d = Reflect.getOwnPropertyDescriptor(obj, key);
      entries.set(`${label}.${String(key)}`, d.get ?? d.set ?? d.value);
    }
  };
  for (const [name, ctor] of Object.entries(builtIns)) {
    add(name, ctor);
    if (ctor.prototype) add(`${name}.prototype`, ctor.prototype);
  }
  return entries;
};
const globalsBefore = new Map(Reflect.ownKeys(globalThis).map((k) => [k, Reflect.getOwnPropertyDescriptor(globalThis, k)]));
const builtInsBefore = snapshot();

if (target.startsWith('data:')) {
  await import(target);
} else if (target.endsWith('.cjs')) {
  createRequire(import.meta.url)(target);
} else {
  await import(pathToFileURL(target).href);
}
// Let any promise chain a module started at load time run its course.
await new Promise((resolve) => realSetTimeout(resolve, 50));

for (const key of Reflect.ownKeys(globalThis)) {
  const before = globalsBefore.get(key);
  const after = Reflect.getOwnPropertyDescriptor(globalThis, key);
  if (!before || ('value' in before && !Object.is(before.value, after.value))) report.globals.push(String(key));
}
for (const [key, value] of snapshot()) {
  if (!builtInsBefore.has(key) || !Object.is(builtInsBefore.get(key), value)) report.patched.push(key);
}

// Serialised before touching process.stdout, whose lazy getter can itself
// register process listeners.
const json = JSON.stringify(report);
process.stdout.write(json, () => process.exit(0));
