/**
 * Serializes work per key so two texts from the same customer (or two Twilio retries)
 * can't interleave calendar reads and writes.
 */
const chains = new Map<string, Promise<unknown>>();

export function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.then(
    () => undefined,
    () => undefined
  );

  chains.set(key, tail);
  void tail.then(() => {
    // Only forget the key if nothing queued up behind this task.
    if (chains.get(key) === tail) chains.delete(key);
  });

  return result;
}
