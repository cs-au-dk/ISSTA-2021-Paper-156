import { cpus } from 'os';
import { queue } from 'async';

export async function asyncFilter<T>(arr: T[], cb: (t: T) => Promise<boolean>): Promise<T[]> {
  const filterBits = await Promise.all(arr.map((t) => cb(t)));
  return arr.filter((_) => filterBits.shift());
}

interface Task<T> {
  idx: number;
  task: T;
}

export async function asyncFilterLimit<T>(
  arr: T[],
  cb: (t: T) => Promise<boolean>,
  limit = cpus().length
): Promise<T[]> {
  const filterBits: boolean[] = [];
  const q = queue(async (t: Task<T>, qcb) => {
    filterBits[t.idx] = await cb(t.task);
    qcb();
  }, limit);
  arr.forEach((a, i) => q.push({ idx: i, task: a }));
  await q.drain();
  if (filterBits.length !== arr.length) {
    throw new Error(`AssertError: expected filterBits.length ${filterBits.length} to equal arr.length ${arr.length}`);
  }
  return arr.filter((_) => filterBits.shift());
}
