---
layout: default
title: Examples
permalink: /examples/
description: Code examples for each async.java combinator — Parallel, Series, Waterfall, Race, Map, Reduce, Queue, Lock, with Loom-friendly idioms.
---

<div class="container container--narrow" style="padding-top: 56px;">
  <h1 style="font-family: var(--font-display); font-size: 36px; letter-spacing: -0.015em; margin: 0 0 12px;">Examples</h1>
  <p style="font-size: 18px; color: var(--fg-muted); margin: 0 0 16px;">
    One small example per combinator. All snippets compile against <code>com.github.async-java:async.java:v{{ site.latest_version }}</code>.
    Imports are elided for readability.
  </p>

<div class="example">
  <h2 class="example__heading">Asyncc.Parallel</h2>
  <p class="example__lede">Fan out N independent tasks. The final callback fires once, with results in the same order as the tasks were submitted.</p>

{% highlight java %}
List<Asyncc.AsyncTask<String, Throwable>> tasks = List.of(
  cb -> exec.submit(() -> cb.done(null, fetchA())),
  cb -> exec.submit(() -> cb.done(null, fetchB())),
  cb -> exec.submit(() -> cb.done(null, fetchC()))
);

Asyncc.Parallel(tasks, (err, results) -> {
  if (err != null) { log.error("at least one failed", err); return; }
  // results.get(0) is fetchA's value, etc.
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.ParallelLimit</h2>
  <p class="example__lede">Parallel with a concurrency cap. Useful when you have many tasks but want to keep in-flight count bounded.</p>

{% highlight java %}
Asyncc.ParallelLimit(8, downloadTasks, (err, paths) -> {
  // At most 8 downloads run concurrently. The next task starts as soon
  // as one finishes. Errors short-circuit the remaining queue.
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Series</h2>
  <p class="example__lede">Run tasks one after another, collecting each result. Stops at the first error.</p>

{% highlight java %}
Asyncc.Series(List.of(
  cb -> validate(req, cb),
  cb -> persist(req, cb),
  cb -> notify(req, cb)
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
  cb -> cb.done(null, parseRequest(raw)),       // ParsedRequest
  (req, cb) -> cb.done(null, authorize(req)),   // AuthorizedRequest
  (authd, cb) -> cb.done(null, run(authd))      // Result
), (err, finalValue) -> {
  // finalValue is the Result from the last stage.
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Race</h2>
  <p class="example__lede">Fan out tasks; the first to call back wins. The rest are ignored (cancellation is best-effort).</p>

{% highlight java %}
Asyncc.Race(List.of(
  cb -> exec.submit(() -> cb.done(null, fromPrimary())),
  cb -> exec.submit(() -> cb.done(null, fromReplica()))
), (err, winnerValue) -> {
  // whichever returned first
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Map</h2>
  <p class="example__lede">Run an async transform over each element. Results preserve input order even though work runs concurrently.</p>

{% highlight java %}
Asyncc.Map(userIds, (id, cb) -> {
  exec.submit(() -> cb.done(null, fetchProfile(id)));
}, (err, profiles) -> {
  // profiles.get(i) corresponds to userIds.get(i)
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.FilterMap</h2>
  <p class="example__lede">Async map + async filter in one pass. Tasks that emit <code>null</code> are dropped from the result.</p>

{% highlight java %}
Asyncc.FilterMap(candidateIds, (id, cb) -> {
  exec.submit(() -> {
    var profile = fetchProfile(id);
    cb.done(null, profile.isActive() ? profile : null);
  });
}, (err, active) -> {
  // active contains only the profiles where isActive() was true
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Asyncc.Reduce</h2>
  <p class="example__lede">Sequential fold with an async reducer. Each step sees the running accumulator.</p>

{% highlight java %}
Asyncc.Reduce(transactions, BigDecimal.ZERO, (acc, txn, cb) -> {
  exec.submit(() -> cb.done(null, acc.add(txn.amount())));
}, (err, total) -> {
  // total is the final sum
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">NeoQueue</h2>
  <p class="example__lede">A bounded async work queue. Push tasks; the queue serialises (or limits) them. Great when you need backpressure without modelling a stream.</p>

{% highlight java %}
NeoQueue<Job> queue = new NeoQueue<>(4); // concurrency = 4

queue.setTaskHandler((job, cb) -> {
  exec.submit(() -> {
    try { processJob(job); cb.done(null, null); }
    catch (Throwable t) { cb.done(t, null); }
  });
});

incomingJobs.forEach(queue::push);
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">NeoLock</h2>
  <p class="example__lede">An async mutex. Unlike <code>synchronized</code> it doesn't pin a virtual thread to a carrier — useful when the critical section yields.</p>

{% highlight java %}
NeoLock lock = new NeoLock();

lock.acquire((err, unlock) -> {
  try {
    // critical section — safe to await async work here
    mutate(sharedState);
  } finally {
    unlock.release();
  }
});
{% endhighlight %}
</div>

<div class="example">
  <h2 class="example__heading">Composition: nesting combinators</h2>
  <p class="example__lede">Combinators nest cleanly because they all use the same error-first callback contract. Below: <code>Waterfall</code> wrapping a <code>Map</code> wrapping a <code>Parallel</code>.</p>

{% highlight java %}
Asyncc.Waterfall(List.of(
  cb -> fetchPage(url, cb),                     // String html
  (html, cb) -> cb.done(null, extractLinks(html)), // List<URI>
  (links, cb) -> Asyncc.Map(links, (link, c) -> {  // List<List<String>>
    Asyncc.Parallel(List.of(
      c2 -> exec.submit(() -> c2.done(null, headOk(link))),
      c2 -> exec.submit(() -> c2.done(null, classify(link)))
    ), (err, pair) -> c.done(err, pair));
  }, cb)
), (err, perLinkData) -> {
  // ...
});
{% endhighlight %}
</div>

<p style="margin-top: 56px; padding-top: 24px; border-top: 1px solid var(--rule); color: var(--fg-muted); font-size: 15px;">
  Looking for full javadoc?
  See <a href="{{ '/v/0.1.0/index.html' | relative_url }}">v0.1.0 javadoc</a>, or
  <a href="{{ site.repo_url }}">browse the source</a>.
</p>

</div>
