---
layout: post
title: "Tracking down a Whilst race, and finishing the variance pass"
subtitle: "v0.2.9 fixes a sync-body race in NeoWhilst.RunMap and widens the Concat family to accept the Asyncc.Task<T> shorthand. The race story is the interesting half."
kicker: "Engineering · v0.2.9 release notes"
date: 2026-05-18
reading_time: "6 min read"
description: "A post-mortem of the NeoWhilst.RunMap race in async.java that double-fired one extra body call past short-circuit for sync-completing bodies, and the design rationale for widening all nine Concat task-list variants to accept the v0.2.8 Asyncc.Task<T> shorthand."
---

v0.2.9 ships two changes. The first &mdash; finishing the `? extends` variance pass on the `Concat` family &mdash; is mechanical follow-through from v0.2.8-rc2. The second &mdash; a one-line gate that fixes a race in `NeoWhilst.RunMap` &mdash; is the more interesting story.

If you tracked the v0.2.8-rc3 release notes you may remember this stanza in `AsyncFutExtendedTest`:

{% highlight java %}
// NeoWhilst's recursion strategy can race one extra body call: when m.run()
// returns before the body's async failure has propagated, NeoWhilst checks the
// test again and may recurse once more. Counter ends at 4 or 5 depending on
// timing.
assertTrue("counter should be 4 or 5 (short-circuit)",
    counter.get() == 4 || counter.get() == 5);
{% endhighlight %}

That `4 || 5` was a hand-wavy accommodation. v0.2.9 closes the race so the assertion is `4` and only `4`. Here's how the race actually lived.

## The reproducer

{% highlight java %}
final AtomicInteger counter = new AtomicInteger();
final CompletableFuture<List<Integer>> fut = AsyncFut.Whilst(
    () -> counter.get() < 10,
    () -> {
      final int now = counter.getAndIncrement();
      if (now == 3) return CompletableFuture.failedFuture(
          new IllegalStateException("whilst-boom"));
      return CompletableFuture.completedFuture(now);
    });
{% endhighlight %}

Reading this code, the intent is unambiguous: run the body until either the test fails or the body fails. The body fails at iteration 3 (the 4th call &mdash; we're zero-indexed). So `counter` should land on exactly `4`.

Run it against v0.2.8 and you'll see `5` about half the time.

## What was happening

`AsyncFut.Whilst` bridges to `Asyncc.Whilst` via a callback adapter that runs the supplied `CompletableFuture`'s `whenComplete`. With `completedFuture(n)` the future is *already* done when the body runs, so `whenComplete` fires its handler **synchronously on the current thread**. The body's "async" `taskCb.success(n)` is in fact a synchronous call back into `NeoWhilst.RunMap`'s `done`.

Inside `RunMap`, the structure looked like this (simplified):

{% highlight java %}
// inside RunMap:
final var taskRunner = new AsyncCallback<T, E>(s) {
  @Override public void done(final E e, final T v) {
    // ... slot write, finished++, error/short-circuit handling ...
    runTest(syncTest, asyncTest, (err, b) -> {
      // (A) the done-callback's truth test → maybe recurse
      if (b && isBelowCapacity) {
        RunMap(syncTest, asyncTest, m, results, c, s, f);
      }
    });
  }
};

m.run(taskRunner);   // user's body

// (B) the post-m.run truth test → maybe recurse
runTest(syncTest, asyncTest, (err, b) -> {
  if (b && isBelowCapacity) {
    RunMap(syncTest, asyncTest, m, results, c, s, f);
  }
});
{% endhighlight %}

Block (B) exists for a real reason. For `WhilstLimit(limit > 1, ...)` &mdash; truly parallel Whilst with up to `limit` concurrent body invocations &mdash; `m.run` returns *before* the body's async `done` fires. We re-test the truth predicate and dispatch more body invocations until we're at the configured fan-out limit. Without block (B), parallel Whilst would only ever have one body in flight.

But for the sync-body case &mdash; `completedFuture` &mdash; here's the actual sequence:

1. `m.run(taskRunner)` calls the body.
2. The body calls `whenComplete` on an already-completed future.
3. The handler fires synchronously: `taskCb.success(0)`.
4. `taskRunner.done(null, 0)` runs to completion, INCLUDING the recursive `RunMap` from block (A) for iteration 2.
5. Iteration 2 runs the same chain. Each iteration's `done` synchronously fires the next.
6. Iteration 4 (`now == 3`) fails. `s.setShortCircuited(true)`. Final callback fires. Iteration 4's `done` returns. Iteration 4's `m.run` returns.
7. **We're now back in iteration 4's stack frame at line (B).** `isBelowCapacity` reads `1 > 4-4 = 0` → `true`. `runTest` returns `b = true` because `counter.get() == 4 < 10`. Block (B) calls `RunMap` *one more time*.
8. Iteration 5 runs `m.run` on the body, which increments counter to 5. Inside `done`: `s.isShortCircuited()` is now true, the early return fires, no further damage. But `counter == 5` is observable to the test.

The short-circuit guarantee was technically preserved (the *final* callback fired exactly once thanks to `fireFinalCallback`'s idempotency), but a body that was supposed to short-circuit on iteration 3 ran a 5th time.

## The fix

The fix is one short circuit:

{% highlight java %}
m.run(taskRunner);

// If the task completed synchronously (taskRunner.done fired inside m.run), the
// done callback above has already run the truth test and dispatched the next
// iteration as needed; do not double-fire here.
if (s.isShortCircuited() || taskRunner.isFinished()) {
  return;
}

// (B) async-body fan-out: m.run returned before done fired, so for limit > 1
// we need to dispatch additional concurrent body invocations.
runTest(syncTest, asyncTest, (err, b) -> {
  if (s.isShortCircuited()) return;  // belt-and-suspenders
  if (b && isBelowCapacity) RunMap(...);
});
{% endhighlight %}

`taskRunner.isFinished()` is the discriminator. For sync bodies, `done` already ran inside `m.run` and the recursive `RunMap` from block (A) handled the next iteration. For async bodies with `limit > 1`, `done` hasn't fired yet, the flag is `false`, and block (B) still does its fan-out job.

## Why I missed it the first time

This was sitting under a relaxed test assertion (`4 || 5`) for the entirety of v0.2.8. I rationalized it at the time as "the body fires, the short-circuit is honored, the counter is just a side effect we observe externally; the user contract is `at most once` final callback and that holds." That's true as far as it goes &mdash; but a user who put non-idempotent side effects inside the body (write to a queue, increment a metric, push to a downstream) would see the extra invocation. Cataloging the at-most-once contract on the *final callback* and ignoring how many times the *body* gets called is a half-answer.

The right invariant is: **once the body fails or the truth test goes false, no further body invocations.** v0.2.9 honors that.

## Concat widening &mdash; the easier half

The Concat family has nine public overloads that accept `List<AsyncTask<T, E>>`:

* `Concat`, `ConcatSeries`, `ConcatLimit` (parallel / series / bounded)
* `Concat(depth)`, `ConcatSeries(depth)`, `ConcatLimit(depth, ...)` (flatten to N levels)
* `ConcatDeep`, `ConcatDeepSeries`, `ConcatDeepLimit` (flatten fully)

Before v0.2.9 these took `List<AsyncTask<T, E>>` invariantly. A `List<Asyncc.Task<T>>` &mdash; the Throwable-fixed shorthand introduced in v0.2.8-rc2 &mdash; is *not* a `List<AsyncTask<T, Throwable>>` despite `Task` extending `AsyncTask`. The user had to manually cast or `new ArrayList<AsyncTask<...>>(list)` at every call site.

v0.2.9 widens all nine to `List<? extends AsyncTask<T, E>>`. Same treatment we gave `Parallel`/`Series`/`ParallelLimit` in v0.2.8-rc2.

While I was in there, the internal `NeoParallel.Parallel`/`NeoParallel.ParallelLimit`/`NeoSeries.Series` package-private methods got the same widening. Those don't mutate the input list (they only call `tasks.iterator()` or `tasks.get(i)`), so widening is safe. The public-API defensive copy that `Asyncc.Parallel`/`Series`/`ParallelLimit` were doing &mdash; `new ArrayList<>(tasks)` to convert variance &mdash; got dropped. One fewer allocation per call.

`ConcatWideningTest` (8 tests) pins that all nine Concat variants accept the shorthand list and produce correctly-flattened results.

## Tally

**192 tests, 0 failures**, 2 JDK 21-gated skips. JitPack: `com.github.async-java:async.java:v0.2.9`. See the [CHANGELOG](https://github.com/async-java/async.java/blob/v0.2.9/CHANGELOG.md) for the full per-release detail.

The race took longer to find than it took to fix &mdash; which is the usual ratio for this kind of bug. The narrowest set of conditions to reproduce it deterministically (sync-completing body, failure midway through, count the body invocations as the observable) makes it the kind of thing that hides until someone counts. v0.2.8 shipped the test that counted. v0.2.9 shipped the fix.
