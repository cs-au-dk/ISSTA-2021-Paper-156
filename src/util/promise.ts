export async function applySeries<T>(array: T[], f: (q: T) => void) {
  for (const elem of array) {
    await f(elem);
  }
}
