import assert from "node:assert/strict";
import test from "node:test";
import { runExclusive } from "./queue";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("tasks on the same key never overlap", async () => {
  const events: string[] = [];

  const task = (name: string, ms: number) =>
    runExclusive("+15555550100", async () => {
      events.push(`${name}:start`);
      await delay(ms);
      events.push(`${name}:end`);
    });

  await Promise.all([task("a", 30), task("b", 5), task("c", 5)]);

  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("different keys run concurrently", async () => {
  const events: string[] = [];

  await Promise.all([
    runExclusive("one", async () => {
      events.push("one:start");
      await delay(20);
      events.push("one:end");
    }),
    runExclusive("two", async () => {
      events.push("two:start");
      await delay(1);
      events.push("two:end");
    }),
  ]);

  assert.deepEqual(events, ["one:start", "two:start", "two:end", "one:end"]);
});

test("a rejected task does not wedge the key", async () => {
  const key = "+15555550199";

  await assert.rejects(runExclusive(key, async () => Promise.reject(new Error("boom"))));
  assert.equal(await runExclusive(key, async () => "recovered"), "recovered");
});
