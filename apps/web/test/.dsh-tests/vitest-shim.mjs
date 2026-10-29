/**
 * vitest 的最小替身：本机 node_modules 的依赖树不完整（装不齐 vitest），
 * 但仓库里已有测试用的是标准 vitest API，所以这里实现一个够用的子集，
 * 让 `node apps/web/test/run-tests.mjs` 能在没有任何依赖的情况下跑测试。
 *
 * 支持：describe / it / expect（toBe, toEqual, toBeCloseTo, toBeGreaterThan,
 * toBeGreaterThanOrEqual, toBeLessThan, toBeLessThanOrEqual, toHaveLength,
 * toBeUndefined, toBeNull, toBeTruthy, toBeFalsy, toContain, toMatch, toThrow）、.not
 */

const failures = [];
const pendings = [];
const stack = [];
let passed = 0;

export function describe(name, fn) {
  stack.push(name);
  try {
    fn();
  } catch (err) {
    failures.push({ full: `${stack.join(' > ')} (describe 体抛错)`, err });
  }
  stack.pop();
}

export function it(name, fn) {
  const full = [...stack, name].join(' > ');
  // 只登记、不立刻执行：report() 里按顺序 await。
  // 之前是"全部并发跑"，多个用例同时替换 globalThis.fetch 时会互相踩，
  // 表现为"上一个用例把 fetch 还原了，下一个用例的请求就打到真网络上"。
  pendings.push({ full, fn });
}

export const test = it;

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!deepEqual(v, b.get(k))) return false;
    return true;
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function show(v) {
  try {
    if (typeof v === 'string') return JSON.stringify(v);
    if (v instanceof Map) return `Map(${JSON.stringify([...v])})`;
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

class Expectation {
  constructor(actual, negated = false) {
    this.actual = actual;
    this.negated = negated;
  }

  get not() {
    return new Expectation(this.actual, !this.negated);
  }

  #check(ok, describe) {
    const good = this.negated ? !ok : ok;
    if (!good) throw new Error(`${this.negated ? 'not ' : ''}${describe}`);
    return this;
  }

  toBe(expected) {
    return this.#check(Object.is(this.actual, expected), `toBe(${show(expected)})，实际 ${show(this.actual)}`);
  }

  toEqual(expected) {
    return this.#check(deepEqual(this.actual, expected), `toEqual(${show(expected)})，实际 ${show(this.actual)}`);
  }

  toBeCloseTo(expected, precision = 2) {
    const diff = Math.abs(Number(this.actual) - Number(expected));
    return this.#check(
      diff < 0.5 * 10 ** -precision,
      `toBeCloseTo(${expected})，实际 ${this.actual}，差 ${diff}`,
    );
  }

  toBeGreaterThan(n) {
    return this.#check(this.actual > n, `toBeGreaterThan(${n})，实际 ${show(this.actual)}`);
  }

  toBeGreaterThanOrEqual(n) {
    return this.#check(this.actual >= n, `toBeGreaterThanOrEqual(${n})，实际 ${show(this.actual)}`);
  }

  toBeLessThan(n) {
    return this.#check(this.actual < n, `toBeLessThan(${n})，实际 ${show(this.actual)}`);
  }

  toBeLessThanOrEqual(n) {
    return this.#check(this.actual <= n, `toBeLessThanOrEqual(${n})，实际 ${show(this.actual)}`);
  }

  toHaveLength(n) {
    return this.#check(
      this.actual?.length === n,
      `toHaveLength(${n})，实际 ${this.actual?.length}`,
    );
  }

  toBeUndefined() {
    return this.#check(this.actual === undefined, `toBeUndefined，实际 ${show(this.actual)}`);
  }

  toBeNull() {
    return this.#check(this.actual === null, `toBeNull，实际 ${show(this.actual)}`);
  }

  toBeTruthy() {
    return this.#check(Boolean(this.actual), `toBeTruthy，实际 ${show(this.actual)}`);
  }

  toBeFalsy() {
    return this.#check(!this.actual, `toBeFalsy，实际 ${show(this.actual)}`);
  }

  toContain(needle) {
    const ok = Array.isArray(this.actual)
      ? this.actual.some((x) => deepEqual(x, needle))
      : String(this.actual).includes(String(needle));
    return this.#check(ok, `toContain(${show(needle)})，实际 ${show(this.actual)}`);
  }

  toMatch(pattern) {
    const text = String(this.actual);
    const ok = pattern instanceof RegExp ? pattern.test(text) : text.includes(String(pattern));
    return this.#check(ok, `toMatch(${pattern})，实际 ${show(this.actual)}`);
  }

  toThrow(expected) {
    let threw = false;
    let thrown;
    try {
      this.actual();
    } catch (err) {
      threw = true;
      thrown = err;
    }
    let ok = threw;
    if (ok && expected !== undefined) {
      const msg = String(thrown?.message ?? '');
      ok = expected instanceof RegExp ? expected.test(msg) : msg.includes(String(expected));
    }
    return this.#check(ok, `toThrow(${expected ?? ''})，实际 threw=${threw} message=${thrown?.message ?? ''}`);
  }
}

export function expect(actual) {
  return new Expectation(actual);
}

/**
 * 跑完并打印结果
 * @param {string} label
 * @returns {Promise<number>} 失败数
 */
export async function report(label) {
  for (const { full, fn } of pendings.splice(0, pendings.length)) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push({ full, err });
    }
  }
  for (const { full, err } of failures) {
    console.log(`  FAIL  ${full}\n        ${err?.message ?? err}`);
  }
  console.log(`${label}: ${passed} 通过, ${failures.length} 失败`);
  return failures.length;
}
