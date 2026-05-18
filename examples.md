---
layout: default
title: Examples
permalink: /examples/
description: Code examples for each async.java combinator — Parallel, Series, Waterfall, Race, Map, Reduce, Queue, Lock, with Loom-friendly idioms and the v0.2.4 ergonomics (c.success, WrapErrFirst.wrap).
---

<div class="container container--narrow" style="padding-top: 56px;" markdown="1">
  <h1 style="font-family: var(--font-display); font-size: 36px; letter-spacing: -0.015em; margin: 0 0 12px;">Examples</h1>
  <p style="font-size: 18px; color: var(--fg-muted); margin: 0 0 16px;">
    One small example per combinator. All snippets compile against <code>com.github.async-java:async.java:v{{ site.latest_version }}</code>.
    Imports are elided for readability.
  </p>

<div style="margin: 24px 0 40px; padding: 16px 22px; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 6px 6px 0;">
  <strong>Conventions used below</strong> &mdash; the continuation parameter is named <code>c</code> (for <em>continuation</em>). Continuations fire via <code>c.success(v)</code>, <code>c.fail(e)</code>, or the canonical <code>c.done(err, v)</code>. The final callback is the error-first callback the combinator takes; wrap it with <code>WrapErrFirst.wrap(...)</code> to skip the <code>if (err != null)...</code> preamble.
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Parallel</h2>
  <p class="example__lede">Fan out N independent tasks. The final callback fires once, with results in the same order as the tasks were submitted.</p>

{% highlight java %}
List<Asyncc.AsyncTask<String, Throwable>> tasks = List.of(
  c -> exec.submit(() -> c.success(fetchA())),
  c -> exec.submit(() -> c.success(fetchB())),
  c -> exec.submit(() -> c.success(fetchC()))
);

Asyncc.Parallel(tasks, (err, results) -> {
  if (err != null) { log.error("at least one failed", err); return; }
  // results.get(0) is fetchA's value, etc.
});
{% endhighlight %}

  <p class="example__lede">Or with <code>wrap</code> to skip the error-check preamble:</p>

{% highlight java %}
import static org.ores.async.WrapErrFirst.wrap;

Asyncc.Parallel(tasks, wrap(results -> {
  reply.send(combine(results.get(0), results.get(1), results.get(2)));
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.ParallelLimit</h2>
  <p class="example__lede">Parallel with a concurrency cap. Useful when you have many tasks but want to keep in-flight count bounded.</p>

{% highlight java %}
Asyncc.ParallelLimit(8, downloadTasks, wrap(paths -> {
  // At most 8 downloads run concurrently. The next task starts as soon
  // as one finishes. Errors short-circuit the remaining queue.
  publish(paths);
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Series</h2>
  <p class="example__lede">Run tasks one after another, collecting each result. Stops at the first error.</p>

{% highlight java %}
Asyncc.Series(List.of(
  c -> validate(req, c),
  c -> persist(req, c),
  c -> notify(req, c)
), (err, results) -> {
  if (err != null) return; // first failure stops the chain
  // results is a List of each task's value in order.
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Waterfall</h2>
  <p class="example__lede">Each task receives the previous task's value. A sequential pipeline with typed hand-offs.</p>

{% highlight java %}
Asyncc.Waterfall(List.of(
  c -> c.success(parseRequest(raw)),       // -> ParsedRequest
  (req, c) -> c.success(authorize(req)),   // -> AuthorizedRequest
  (authd, c) -> c.success(run(authd))      // -> Result
), wrap(finalValue -> {
  // finalValue is the Result from the last stage.
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Race</h2>
  <p class="example__lede">Fan out tasks; the first to call back wins. The rest are ignored (cancellation is best-effort).</p>

{% highlight java %}
Asyncc.Race(List.of(
  c -> exec.submit(() -> c.success(fromPrimary())),
  c -> exec.submit(() -> c.success(fromReplica()))
), wrap(winnerValue -> {
  // whichever returned first
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Map</h2>
  <p class="example__lede">Run an async transform over each element. Results preserve input order even though work runs concurrently.</p>

{% highlight java %}
Asyncc.Map(userIds, (id, c) -> {
  exec.submit(() -> c.success(fetchProfile(id)));
}, wrap(profiles -> {
  // profiles.get(i) corresponds to userIds.get(i)
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.FilterMap</h2>
  <p class="example__lede">Async map + async filter in one pass. Tasks that emit <code>null</code> are dropped from the result.</p>

{% highlight java %}
Asyncc.FilterMap(candidateIds, (id, c) -> {
  exec.submit(() -> {
    var profile = fetchProfile(id);
    c.success(profile.isActive() ? profile : null);
  });
}, wrap(active -> {
  // active contains only the profiles where isActive() was true
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Reduce</h2>
  <p class="example__lede">Sequential fold with an async reducer. Each step sees the running accumulator.</p>

{% highlight java %}
Asyncc.Reduce(transactions, BigDecimal.ZERO, (acc, txn, c) -> {
  exec.submit(() -> c.success(acc.add(txn.amount())));
}, wrap(total -> {
  // total is the final sum
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Times</h2>
  <p class="example__lede">Run the same task N times in parallel, collect each result. Useful for "spawn N workers" or "generate N samples".</p>

{% highlight java %}
Asyncc.Times(8, (i, c) -> {
  exec.submit(() -> c.success(generateSample(i)));
}, wrap(samples -> {
  // samples.size() == 8
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.GroupBy</h2>
  <p class="example__lede">Apply an async keying function to each element, then group input elements by their key.</p>

{% highlight java %}
Asyncc.GroupBy(users, (user, c) -> {
  c.success(user.region());
}, wrap(grouped -> {
  // grouped is Map<String, List<User>> — users keyed by region
}));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">NeoQueue</h2>
  <p class="example__lede">A bounded async work queue. Push tasks; the queue serialises (or limits) them. Great when you need backpressure without modelling a stream.</p>

{% highlight java %}
NeoQueue<Job, Void> queue = new NeoQueue<>(4); // concurrency = 4

queue.setTaskHandler((task, c) -> {
  exec.submit(() -> {
    try { processJob(task.getValue()); c.success(null); }
    catch (Throwable t) { c.fail(t); }
  });
});

queue.saturated(q -> log.warn("queue saturated; in-flight at cap"));
queue.drain(q -> log.info("queue drained"));

incoming.forEach(queue::push);
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">NeoLock</h2>
  <p class="example__lede">An async mutex. Unlike <code>synchronized</code> it doesn't tie the release to the acquiring thread — useful when the critical section ends inside an async completion handler.</p>

{% highlight java %}
NeoLock lock = new NeoLock("inventory");

lock.acquire((err, unlock) -> {
  try {
    // critical section — safe to await async work here
    mutate(sharedState);
  } finally {
    unlock.releaseLock();
  }
});

// Or use the leak-safe sync helper (v0.2.5+):
lock.withLock(() -> mutate(sharedState));
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">NeoRwLock <span style="font-family: var(--font-mono); font-size: 14px; color: var(--fg-dim);">(v0.2.6+)</span></h2>
  <p class="example__lede">Async reader/writer lock. Many concurrent readers, one exclusive writer. FIFO with reader-burst fairness — adjacent queued readers wake up concurrently when the lock becomes free.</p>

{% highlight java %}
NeoRwLock cacheLock = new NeoRwLock("config-cache");

// Reader — concurrent with other readers.
cacheLock.acquireRead((err, unlock) -> {
  try {
    return cache.get(key);
  } finally {
    unlock.releaseLock();
  }
});

// Writer — exclusive.
cacheLock.acquireWrite((err, unlock) -> {
  try {
    cache.put(key, value);
  } finally {
    unlock.releaseLock();
  }
});

// Sync helpers — auto-release even if the body throws.
cacheLock.withRead(() -> renderTemplate(cache));
cacheLock.withWrite(() -> cache.refresh());

// Non-blocking attempt — empty if waiters queued (preserves FIFO).
cacheLock.tryAcquireRead().ifPresent(u -> {
  try { /* read-only work */ } finally { u.releaseLock(); }
});

// Bounded wait — fires onError with TimeoutException on miss.
cacheLock.acquireWrite(500L, (err, unlock) -> {
  if (err instanceof TimeoutException) { backOff(); return; }
  // ... exclusive write under the timeout budget
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Composition: nesting combinators</h2>
  <p class="example__lede">Combinators nest cleanly because they all use the same error-first callback contract. Below: <code>Waterfall</code> wrapping a <code>Map</code> wrapping a <code>Parallel</code>.</p>

{% highlight java %}
Asyncc.Waterfall(List.of(
  c -> fetchPage(url, c),                            // -> String html
  (html, c) -> c.success(extractLinks(html)),        // -> List<URI>
  (links, c) -> Asyncc.Map(links, (link, inner) -> { // -> List<List<String>>
    Asyncc.Parallel(List.of(
      c2 -> exec.submit(() -> c2.success(headOk(link))),
      c2 -> exec.submit(() -> c2.success(classify(link)))
    ), inner);
  }, c)
), wrap(perLinkData -> {
  // perLinkData is List<List<String>>, ordered the same as the source links list
}));
{% endhighlight %}

  <p class="example__lede">For a much larger composition — 8+ combinators in one pipeline — see <a href="{{ '/composability/' | relative_url }}">the composability showcase</a>.</p>
</div>

<div class="example">
  <h2 class="example__heading">WrapFuture <span style="font-family: var(--font-mono); font-size: 14px; color: var(--fg-dim);">(v0.2.7+)</span></h2>
  <p class="example__lede">Bidirectional bridge to <code>CompletableFuture</code>. Wrap any combinator call as a promise at the boundary, or wrap a third-party promise as an async.java task.</p>

{% highlight java %}
import static org.ores.async.WrapFuture.toFuture;
import static org.ores.async.WrapFuture.fromStage;

// Return a CompletableFuture to a Spring WebFlux / Akka HTTP / gRPC boundary,
// while using async.java's combinators internally.
public CompletableFuture<String> handle(Request req) {
  return toFuture(c ->
      Asyncc.<String, Throwable>Parallel(List.of(
          cb -> exec.submit(() -> cb.success(fetchA(req))),
          cb -> exec.submit(() -> cb.success(fetchB(req)))
      ), c)
  ).thenApply(parts -> combine(parts.get(0), parts.get(1)));
}

// Consume third-party CompletionStage-returning APIs inside an async.java combinator.
Asyncc.Parallel(List.of(
    fromStage(db.queryAsync("SELECT ...")),
    fromStage(redis.getAsync(key)),
    fromStage(http.sendAsync(req))
), (err, results) -> { /* ... */ });
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">AsyncFut <span style="font-family: var(--font-mono); font-size: 14px; color: var(--fg-dim);">(v0.2.7+)</span></h2>
  <p class="example__lede">Promise-returning sibling to <code>Asyncc</code>. Same combinator vocabulary, but each call returns a <code>CompletableFuture</code> instead of taking a final callback.</p>

{% highlight java %}
// Parallel: fan out N tasks, return a future of their ordered results.
CompletableFuture<List<String>> both = AsyncFut.Parallel(List.of(
    () -> CompletableFuture.supplyAsync(this::fetchA, exec),
    () -> CompletableFuture.supplyAsync(this::fetchB, exec)
));

// ParallelLimit: bounded concurrency.
CompletableFuture<List<Path>> downloaded = AsyncFut.ParallelLimit(8, downloads);

// Series: sequential.
CompletableFuture<List<Step>> chain = AsyncFut.Series(List.of(
    () -> validate(req), () -> persist(req), () -> notify(req)
));

// Race: first completer wins.
CompletableFuture<String> winner = AsyncFut.Race(List.of(
    () -> fromPrimary(),
    () -> fromReplica()
));

// Map: async transform preserving input order.
CompletableFuture<List<Profile>> profiles =
    AsyncFut.Map(userIds, id -> fetchProfileAsync(id));

// Reduce: sequential async fold.
CompletableFuture<BigDecimal> total =
    AsyncFut.Reduce(txns, BigDecimal.ZERO, (acc, t) -> computeAsync(acc, t));

// Times: N parallel iterations.
CompletableFuture<List<Sample>> samples =
    AsyncFut.Times(8, i -> generateAsync(i));

// Each: per-element fire-and-forget; future completes when all done.
CompletableFuture<Void> sent = AsyncFut.Each(users, u -> sendEmailAsync(u));

// Compose with regular CompletableFuture operators.
AsyncFut.Parallel(taskSuppliers)
    .thenApply(parts -> combine(parts))
    .thenCompose(combined -> store(combined))
    .exceptionally(err -> { log.error("pipeline failed", err); return null; });
{% endhighlight %}
</div>

<p style="margin-top: 56px; padding-top: 24px; border-top: 1px solid var(--rule); color: var(--fg-muted); font-size: 15px;">
  Looking for full javadoc?
  See the <a href="{{ '/v/latest/index.html' | relative_url }}">latest javadoc</a> or the
  <a href="{{ '/v/0.2.7/index.html' | relative_url }}">v0.2.7 snapshot</a>, or
  <a href="{{ site.repo_url }}">browse the source</a>.
</p>

</div>
