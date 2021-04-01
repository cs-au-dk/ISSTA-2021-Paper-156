export function addToMapSet<K, V>(
  target: Map<K, Set<V> | SetWithToStringEquality<V>> | MapWithToStringEquality<K, Set<V> | SetWithToStringEquality<V>>,
  key: K,
  value: V
) {
  if (!target.has(key)) target.set(key, new Set());
  (target.get(key) as Set<V> | SetWithToStringEquality<V>).add(value);
}

export function addAllToMapSet<K, V>(target: Map<K, Set<V>>, key: K, values: Set<V>) {
  if (!target.has(key)) target.set(key, new Set());
  values.forEach((value) => (target.get(key) as Set<V>).add(value));
}

export function addMapSetToMapMapSet<K, K2, V>(
  target: Map<K, Map<K2, SetWithToStringEquality<V>>>,
  key: K,
  values: Map<K2, SetWithToStringEquality<V>>
) {
  if (!target.has(key)) target.set(key, new Map());
  values.forEach((v, k) => {
    if (!(target.get(key) as Map<K2, SetWithToStringEquality<V>>).has(k)) {
      (target.get(key) as Map<K2, SetWithToStringEquality<V>>).set(k, new SetWithToStringEquality());
    }
    const setToAddTo = (target.get(key) as Map<K2, SetWithToStringEquality<V>>).get(k) as SetWithToStringEquality<V>;
    v.forEach((e) => setToAddTo.add(e));
  });
}

export function joinMaps<K, V>(
  m1: Map<K, V> | MapWithToStringEquality<K, V>,
  m2: Map<K, V> | MapWithToStringEquality<K, V>
) {
  m2.forEach((val, key) => m1.set(key, val));
}

export function joinSets<V>(s1: Set<V> | SetWithToStringEquality<V>, s2: Set<V> | SetWithToStringEquality<V>) {
  s2.forEach((val) => s1.add(val));
}

export function joinMapSets<K, V>(
  m1: Map<K, Set<V> | SetWithToStringEquality<V>> | MapWithToStringEquality<K, Set<V> | SetWithToStringEquality<V>>,
  m2: Map<K, Set<V> | SetWithToStringEquality<V>> | MapWithToStringEquality<K, Set<V> | SetWithToStringEquality<V>>
) {
  m2.forEach((val, key) => {
    if (!m1.has(key)) m1.set(key, val);
    else joinSets(m1.get(key) as Set<V> | SetWithToStringEquality<V>, val);
  });
}

// note: inefficient
export function setUnion<T>(sets: Set<T>[]) {
  return sets.reduce((combined, list) => {
    return new Set([...combined, ...list]);
  }, new Set());
}

export function setWithToStringEqualityUnion<T>(sets: SetWithToStringEquality<T>[]) {
  const res: SetWithToStringEquality<T> = new SetWithToStringEquality();
  sets.forEach((set) => set.forEach((e) => res.add(e)));
  return res;
}

export function addToMapSetWithStringEquality<K, V>(
  target: MapWithToStringEquality<K, SetWithToStringEquality<V>> | Map<K, SetWithToStringEquality<V>>,
  key: K,
  value: V
) {
  if (!target.has(key)) target.set(key, new SetWithToStringEquality());
  (target.get(key) as SetWithToStringEquality<V>).add(value);
}
export function addAllToMapSetWithStringEquality<K, V>(
  target: Map<K, SetWithToStringEquality<V>> | MapWithToStringEquality<K, SetWithToStringEquality<V>>,
  key: K,
  values: SetWithToStringEquality<V> | Set<V>
) {
  if (!target.has(key)) target.set(key, new SetWithToStringEquality());
  values.forEach((value) => (target.get(key) as SetWithToStringEquality<V>).add(value));
}

export class SetWithToStringEquality<T extends { toString: () => string }> implements Iterable<T> {
  private contents: Map<string, T>;
  [Symbol.iterator] = this.values;

  constructor(initValues?: T[] | SetWithToStringEquality<T>) {
    this.contents = new Map();
    if (initValues) initValues.forEach((v) => this.add(v));
  }

  add(element: T): void {
    const stringValue = element.toString();
    if (!this.contents.has(stringValue)) this.contents.set(stringValue, element);
  }

  delete(element: T): void {
    const stringValue = element.toString();
    this.contents.delete(stringValue);
  }

  has(element: T): boolean {
    return this.contents.has(element.toString());
  }

  get size(): number {
    return this.contents.size;
  }

  values(): IterableIterator<T> {
    return this.contents.values();
  }

  forEach(iter: (e: T) => void): void {
    [...this.contents.values()].forEach(iter);
  }
}

export class MapWithToStringEquality<K extends { toString: () => string }, V> {
  private valuesMap: Map<string, V>;
  private keysMap: Map<string, K>;
  constructor() {
    this.valuesMap = new Map();
    this.keysMap = new Map();
  }

  has(k: K) {
    return this.valuesMap.has(k.toString());
  }

  set(k: K, v: V) {
    this.keysMap.set(k.toString(), k);
    this.valuesMap.set(k.toString(), v);
  }

  get(k: K): V | undefined {
    return this.valuesMap.get(k.toString());
  }

  delete(k: K) {
    this.valuesMap.delete(k.toString());
    this.keysMap.delete(k.toString());
  }

  get size() {
    return this.valuesMap.size;
  }

  values() {
    return this.valuesMap.values();
  }

  entries(): [K, V][] {
    return [...this.valuesMap.keys()].map((k) => [this.keysMap.get(k) as K, this.valuesMap.get(k) as V]);
  }

  forEach(iteratee: (n: V, k: K) => void) {
    // Only supports forEach calls that only uses value component
    [...this.valuesMap.keys()].forEach((k) => iteratee(this.valuesMap.get(k) as V, this.keysMap.get(k) as K));
  }

  keys() {
    return this.keysMap.values();
  }
}
