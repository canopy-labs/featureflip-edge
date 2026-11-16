/**
 * The one place this package writes to the console.
 *
 * Failure paths report the underlying error verbatim, so a config-load failure
 * is never silent. That error can come from a `fetch` the caller supplied, and
 * the SDK sends the key as the `Authorization` header on every request, so a
 * fetch whose error quotes request headers would hand the credential to
 * whatever the host ships logs to (#5167). The logger replaces the exact key in
 * every string, error and plain object it is given, so no call site has to
 * remember to.
 *
 * @internal Not part of the public API.
 */

const REPLACEMENT = '[redacted]';

/**
 * Below this, the value is not treated as a credential. A real key is
 * `sdk_server_`/`sdk_client_` plus 43 base64url characters, 54 in total.
 * Redacting a short value corrupts every word it appears inside.
 */
const MIN_REDACTABLE_LENGTH = 20;

export interface Logger {
  warn(...args: unknown[]): void;
}

export function redactString(text: string, secret: string): string {
  if (secret.length < MIN_REDACTABLE_LENGTH || !text.includes(secret)) return text;
  return text.split(secret).join(REPLACEMENT);
}

/** Whether `secret` is long enough to be treated as a credential at all. */
function redactable(secret: string): boolean {
  return secret.length >= MIN_REDACTABLE_LENGTH;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own enumerable properties an Error carries besides the ones handled by name. */
function extraKeys(err: Error): string[] {
  return Object.keys(err).filter((k) => k !== 'name' && k !== 'message' && k !== 'stack');
}

/**
 * Whether `secret` appears anywhere redaction would reach: strings, Errors
 * (name, message, stack, cause, `errors`, own properties), arrays and plain
 * objects. Cycle-safe, and allocates nothing.
 */
function contains(value: unknown, secret: string, seen: Set<object>): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((v) => contains(v, secret, seen));
  if (value instanceof Error) {
    return (
      contains(value.name, secret, seen) ||
      contains(value.message, secret, seen) ||
      contains(value.stack, secret, seen) ||
      contains((value as { cause?: unknown }).cause, secret, seen) ||
      contains((value as { errors?: unknown }).errors, secret, seen) ||
      extraKeys(value).some((k) => contains((value as unknown as Record<string, unknown>)[k], secret, seen))
    );
  }
  if (isPlainObject(value)) {
    return Object.values(value).some((v) => contains(v, secret, seen));
  }
  return containsOpaque(value, secret, seen);
}

/** `Map`/`Set`/`Headers`-style entries, or undefined when there are none to read. */
function entriesOf(value: object): unknown[][] | undefined {
  try {
    const entries = (value as { entries?: () => Iterable<unknown> }).entries;
    if (typeof entries !== 'function') return undefined;
    return Array.from(entries.call(value), (e) => (Array.isArray(e) ? e : [e]));
  } catch {
    return undefined;
  }
}

function jsonOf(value: object): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Class instances, URLs, Maps, Headers and the like: anything that is not plain data. */
function containsOpaque(value: object, secret: string, seen: Set<object>): boolean {
  try {
    if (value instanceof URL) return String(value).includes(secret);
  } catch {
    // fall through to the generic probes
  }
  const entries = entriesOf(value);
  if (entries?.some((pair) => pair.some((x) => contains(x, secret, seen)))) return true;
  if (Object.values(value).some((v) => contains(v, secret, seen))) return true;
  // Request/Response keep their state behind prototype getters.
  for (const k of ['url', 'headers']) {
    try {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined && v !== value && contains(v, secret, seen)) return true;
    } catch {
      // a throwing getter holds nothing we can read
    }
  }
  return jsonOf(value)?.includes(JSON.stringify(secret).slice(1, -1)) ?? false;
}

/** A redacted string standing in for a flagged object that cannot be copied structurally. */
function renderRedacted(value: object, secret: string): string {
  try {
    if (value instanceof URL) return redactString(String(value), secret);
  } catch {
    // fall through
  }
  const json = jsonOf(value);
  if (json !== undefined && json !== '{}') return redactString(json, secret);
  const entries = entriesOf(value);
  if (entries) {
    const rendered = jsonOf(entries.map((pair) => pair.map((x) => (typeof x === 'string' ? x : String(x)))));
    if (rendered !== undefined) return redactString(rendered, secret);
  }
  const parts: string[] = [];
  for (const k of ['url', 'headers']) {
    try {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined && v !== value) {
        parts.push(`${k}=${typeof v === 'object' && v !== null ? renderRedacted(v, secret) : String(v)}`);
      }
    } catch {
      // skip
    }
  }
  return parts.length ? redactString(parts.join(' '), secret) : '[redacted object]';
}

/** A copy with the secret removed. Only called on a value `contains` flagged. */
function copyRedacted(value: unknown, secret: string, memo: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactString(value, secret);
  if (value === null || typeof value !== 'object') return value;
  if (memo.has(value)) return memo.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    memo.set(value, out);
    for (const v of value) out.push(copyRedacted(v, secret, memo));
    return out;
  }
  if (value instanceof Error) {
    const message = redactString(value.message, secret);
    const copy: Error = value instanceof AggregateError ? new AggregateError([], message) : new Error(message);
    memo.set(value, copy);
    copy.name = redactString(value.name, secret);
    if (value.stack !== undefined) copy.stack = redactString(value.stack, secret);
    const src = value as unknown as Record<string, unknown>;
    const dst = copy as unknown as Record<string, unknown>;
    for (const k of extraKeys(value)) dst[k] = copyRedacted(src[k], secret, memo);
    // `cause` and AggregateError's `errors` are own but non-enumerable.
    if ('cause' in value) dst.cause = copyRedacted(src.cause, secret, memo);
    if (value instanceof AggregateError) dst.errors = copyRedacted(value.errors, secret, memo);
    return copy;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    memo.set(value, out);
    for (const [k, v] of Object.entries(value)) out[k] = copyRedacted(v, secret, memo);
    return out;
  }
  // Not plain data and flagged by `contains`: never pass it through.
  const rendered = renderRedacted(value, secret);
  memo.set(value, rendered);
  return rendered;
}

/**
 * `value` itself when it does not mention the key (same reference, so
 * `instanceof` and class identity survive), else a copy with the key removed.
 */
export function redactError(err: unknown, secret: string): unknown {
  return redactValue(err, secret);
}

function redactValue(value: unknown, secret: string): unknown {
  if (!redactable(secret) || !contains(value, secret, new Set())) return value;
  return copyRedacted(value, secret, new WeakMap());
}

export function createLogger(secret: string): Logger {
  return {
    warn(...args) {
      console.warn(...(redactable(secret) ? args.map((a) => redactValue(a, secret)) : args));
    },
  };
}

/** For code with no key in scope (a bare snapshot or store). */
export const defaultLogger: Logger = createLogger('');
