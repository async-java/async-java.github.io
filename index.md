---
layout: default
title: async.java — async control flow for Java
description: A small, predictable, virtual-thread-friendly callback combinator library for Java. Parallel, Series, Waterfall, Race, Map, Reduce, Queue, Lock.
---

<section class="hero">
  <div class="container hero__inner">
    <div>
      <p class="hero__kicker">v{{ site.latest_version }} · MIT · JDK 11+ · JDK 21 native</p>
      <h1 class="hero__title">Callback-based async control flow for <em>Java</em>, that plays nice with Loom.</h1>
      <p class="hero__subtitle">A Java port of the Node.js <code>async</code> library. Compose <code>Parallel</code>, <code>Series</code>, <code>Waterfall</code>, <code>Race</code>, <code>Map</code>, <code>Reduce</code>, <code>Queue</code>, and <code>Lock</code> into pipelines. ~50&nbsp;µs per orchestration overhead. Backed by virtual threads when you want them.</p>
      <div class="hero__buttons">
        <a class="btn btn--primary" href="#install">Install &rarr;</a>
        <a class="btn btn--ghost" href="{{ '/examples/' | relative_url }}">See examples</a>
        <a class="btn btn--ghost" href="{{ site.repo_url }}" rel="noopener">GitHub</a>
      </div>
    </div>
    <div class="hero__code" aria-hidden="false">
<pre><span class="c-cm">// fan out two enrichment lookups, score, serialize</span>
<span class="c-kw">final var</span> tasks = <span class="c-ty">List</span>.<span class="c-fn">of</span>(
  c <span class="c-kw">-&gt;</span> exec.<span class="c-fn">submit</span>(() <span class="c-kw">-&gt;</span> c.<span class="c-fn">success</span>(lookupA(req))),
  c <span class="c-kw">-&gt;</span> exec.<span class="c-fn">submit</span>(() <span class="c-kw">-&gt;</span> c.<span class="c-fn">success</span>(lookupB(req)))
);

<span class="c-ty">Asyncc</span>.<span class="c-fn">Parallel</span>(tasks, <span class="c-fn">wrap</span>(results <span class="c-kw">-&gt;</span> {
  <span class="c-kw">var</span> scored = <span class="c-fn">score</span>(req, results.<span class="c-fn">get</span>(<span class="c-kw">0</span>), results.<span class="c-fn">get</span>(<span class="c-kw">1</span>));
  reply.<span class="c-fn">send</span>(<span class="c-fn">serialize</span>(scored));
}));</pre>
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <p class="section__title">Why async.java</p>
    <h2 class="section__heading">Three properties you can rely on.</h2>
    <p class="section__lede">
      Most async-coordination libraries on the JVM grew out of pre-Loom assumptions: they own their thread pool, they
      assume long-running flows, and they layer many frames between you and your code. async.java picks a different
      point in the design space.
    </p>
    <div class="feature-grid">
      <article class="feature">
        <div class="feature__icon">// near-zero overhead</div>
        <h3 class="feature__title">~50 µs per orchestration</h3>
        <p class="feature__body">No actor mailbox, no graph materialisation, no per-call scheduling layer. <code>Asyncc.Parallel</code> is a heap allocation + a couple of atomic increments + your callback. The library never gets in the way.</p>
      </article>
      <article class="feature">
        <div class="feature__icon">// virtual-thread native</div>
        <h3 class="feature__title">Loom is a co-processor, not a replacement</h3>
        <p class="feature__body">Pass <code>Executors.newVirtualThreadPerTaskExecutor()</code> to <code>NeoQueue</code> or your tasks and every fan-out spawns on a virtual thread. The library handles the orchestration; Loom handles the threads.</p>
      </article>
      <article class="feature">
        <div class="feature__icon">// predictable</div>
        <h3 class="feature__title">At-most-once final callback</h3>
        <p class="feature__body">Hardened in v0.2.x with dedup guards, atomic counters, slot-write-before-counter-increment ordering, and a v0.2.4 fix for the <code>ArrayList</code> resize race under high-throughput fan-out. Adversarial fuzz tests pin the at-most-once contract across all combinators.</p>
      </article>
    </div>
    <div class="feature-grid" style="margin-top: 28px;">
      <article class="feature">
        <div class="feature__icon">// v0.2.4 ergonomics</div>
        <h3 class="feature__title"><code>c.success(v)</code> / <code>c.fail(e)</code></h3>
        <p class="feature__body">Shorthand for <code>c.done(null, v)</code> and <code>c.done(e, null)</code>. The continuation parameter is named <code>c</code> &mdash; short for <em>continuation</em> &mdash; everywhere in the docs.</p>
      </article>
      <article class="feature">
        <div class="feature__icon">// no boilerplate</div>
        <h3 class="feature__title"><code>WrapErrFirst.wrap(...)</code></h3>
        <p class="feature__body">Wrap a value-only consumer into an error-first callback and skip the <code>if (err != null)...</code> preamble. Throws on unhandled errors; pair with an explicit error consumer if you want both branches.</p>
      </article>
      <article class="feature">
        <div class="feature__icon">// composability</div>
        <h3 class="feature__title">Combinators nest cleanly</h3>
        <p class="feature__body"><code>Waterfall</code> wrapping a <code>Map</code> wrapping a <code>Parallel</code> wrapping a <code>Race</code> is a perfectly normal pipeline &mdash; they all use the same error-first callback shape. See the <a href="{{ '/composability/' | relative_url }}">composability showcase</a>.</p>
      </article>
    </div>
  </div>
</section>

<section class="section section--quiet">
  <div class="container container--narrow" markdown="1">

## What's new in v0.2.9

Two changes, both diagnosed from `AsyncFut.Whilst`'s production behavior:

* **`NeoWhilst.RunMap` race fixed.** A sync-completing body
  (`AsyncFut.Whilst` with an already-completed `CompletableFuture` &mdash;
  common in tests and cache-hit paths) was double-dispatching one extra
  body call past short-circuit. The truth-test ran in two places: inside
  the per-task `done` callback (which already recurses if the loop
  should continue) AND in a post-`m.run` block intended for async-body
  fan-out at `limit > 1`. For sync-completing bodies the post-`m.run`
  test would re-fire after the chain had already settled. Now gated on
  `s.isShortCircuited() || taskRunner.isFinished()` &mdash; the
  async-body fan-out path is unchanged.

* **`Concat`/`ConcatSeries`/`ConcatLimit`/`ConcatDeep`/`ConcatDeepSeries`/`ConcatDeepLimit`
  task-list variants widened to `List<? extends AsyncTask<T, E>>`.**
  Same `? extends` treatment we applied to `Parallel`/`Series`/`ParallelLimit`
  in v0.2.8-rc2. A `List<Asyncc.Task<T>>` (the Throwable-fixed shorthand)
  now flows into all nine Concat overloads without an explicit cast or
  defensive copy. Internal `NeoParallel`/`NeoSeries` methods widened too,
  so the public-API defensive `ArrayList` copy could be elided &mdash; one
  fewer allocation per `Asyncc.Parallel`/`Series`/`ParallelLimit` call.

Read the full deep-dive: [Tracking down a Whilst race]({{ '/blog/2026/05/18/whilst-race-and-concat-widening/' | relative_url }}).

**192 tests, 0 failures, 2 JDK 21-gated skips.**

  </div>
</section>

<section class="section section--quiet" id="install">
  <div class="container">
    <p class="section__title">Install</p>
    <h2 class="section__heading">JitPack (live within minutes of a git tag).</h2>
    <p class="section__lede">Add the JitPack repository and pin the version. Releases are signed git tags on the
      <a href="{{ site.repo_url }}">main repo</a>; see the <a href="{{ site.repo_url }}/releases">releases page</a> for the latest.</p>

{% highlight xml %}
<!-- pom.xml -->
<repositories>
  <repository>
    <id>jitpack.io</id>
    <url>https://jitpack.io</url>
  </repository>
</repositories>

<dependency>
  <groupId>com.github.async-java</groupId>
  <artifactId>async.java</artifactId>
  <version>v{{ site.latest_version }}</version>
</dependency>
{% endhighlight %}

    <p style="margin-top: 24px; color: var(--fg-muted); font-size: 15px;">For Gradle, see the
      <a href="https://jitpack.io/#async-java/async.java/v{{ site.latest_version }}">JitPack page for v{{ site.latest_version }}</a>. The library targets JDK 11 but is tested on 11, 17, and 21.</p>
  </div>
</section>

<section class="section">
  <div class="container">
    <p class="section__title">Combinators</p>
    <h2 class="section__heading">A small, composable surface.</h2>
    <p class="section__lede">Every combinator takes tasks (or values) and an error-first final callback. Compose them
      freely — they nest without surprises because they all honor the same at-most-once final-callback contract.</p>
    <div class="combinator-list">
      <span class="combinator">Asyncc.Parallel</span>
      <span class="combinator">Asyncc.ParallelLimit</span>
      <span class="combinator">Asyncc.Series</span>
      <span class="combinator">Asyncc.Waterfall</span>
      <span class="combinator">Asyncc.Race</span>
      <span class="combinator">Asyncc.Times</span>
      <span class="combinator">Asyncc.Each</span>
      <span class="combinator">Asyncc.Map</span>
      <span class="combinator">Asyncc.FilterMap</span>
      <span class="combinator">Asyncc.Reduce</span>
      <span class="combinator">Asyncc.GroupBy</span>
      <span class="combinator">Asyncc.Concat</span>
      <span class="combinator">Asyncc.Inject</span>
      <span class="combinator">Asyncc.Whilst</span>
      <span class="combinator">Asyncc.DoWhilst</span>
      <span class="combinator">NeoQueue</span>
      <span class="combinator">NeoLock</span>
      <span class="combinator">NeoRwLock</span>
      <span class="combinator">WrapFuture</span>
      <span class="combinator">AsyncFut</span>
    </div>
    <p style="margin-top: 28px;"><a class="btn btn--ghost" href="{{ '/examples/' | relative_url }}">Examples for each &rarr;</a></p>
  </div>
</section>

<section class="section section--quiet">
  <div class="container">
    <p class="section__title">Benchmark</p>
    <h2 class="section__heading">async.java vs Akka Streams under load.</h2>
    <p class="section__lede">Same 5-stage pipeline, both orchestrators, 60-second sustained WebSocket runs from a Rust
      load tester. Numbers are end-to-end round-trip latency (parse → validate → enrich&nbsp;∥ → score → serialize) on JDK 21
      with a virtual-thread executor. Full methodology in the <a href="{{ '/blog/' | relative_url }}">load-curve post</a>.</p>
    <div class="metrics">
      <table>
        <thead>
          <tr>
            <th>offered load</th>
            <th>library</th>
            <th>p50</th>
            <th>p99</th>
            <th>max</th>
            <th>drops</th>
          </tr>
        </thead>
        <tbody>
          <tr class="row-async"><td rowspan="2">500 msg/s<br>(50 × 10)</td><td>async.java</td><td>5.7 ms</td><td>14.3 ms</td><td>46 ms</td><td>0</td></tr>
          <tr><td>akka-streams</td><td>17.8 ms</td><td>30.7 ms</td><td>55 ms</td><td>0</td></tr>
          <tr class="row-async"><td rowspan="2">1 000 msg/s<br>(200 × 5)</td><td>async.java</td><td>5.1 ms</td><td>14.8 ms</td><td>21 ms</td><td>0</td></tr>
          <tr><td>akka-streams</td><td>5.9 ms</td><td><span class="gap-strong">54.3 ms</span></td><td>100 ms</td><td>0</td></tr>
          <tr class="row-async"><td rowspan="2">2 500 msg/s<br>(50 × 50)</td><td>async.java</td><td>5.0 ms</td><td>11.5 ms</td><td>18 ms</td><td>0</td></tr>
          <tr><td>akka-streams</td><td><span class="gap-strong">2 017 ms</span></td><td><span class="gap-strong">5 230 ms</span></td><td>6 258 ms</td><td><span class="gap-strong">~14 %</span></td></tr>
        </tbody>
      </table>
    </div>
    <p style="margin-top: 28px; color: var(--fg-muted); font-size: 15px;">
      <strong>The gap is dispatcher queue-wait.</strong> async.java's per-call overhead doesn't enqueue anything onto a shared
      contended structure, so it stays flat as load grows. Akka Streams' per-call <code>runWith</code> queues a fresh actor
      mailbox; under saturation the queue depth itself becomes the tail latency. Read
      <a href="{{ site.baseurl }}/blog/2026/05/17/async-java-vs-akka-streams/">the full breakdown</a>.</p>
  </div>
</section>

<section class="section">
  <div class="container">
    <p class="section__title">Project Loom</p>
    <h2 class="section__heading">Callbacks are continuations now.</h2>
    <p class="section__lede">Loom changed what "blocking" costs. It didn't change what coordinating a fan-out costs.
      async.java handles the coordination; Loom handles the threads. The two compose cleanly.</p>

{% highlight java %}
// One executor for the whole app. VT spawn is ~250 ns; cost is essentially free.
final var vt = Executors.newVirtualThreadPerTaskExecutor();

// Optional: route NeoQueue defaults through VTs too.
NeoQueue.setExecutor(vt);

// Now every task is a virtual thread. Blocking I/O inside a task is a continuation
// park, not a kernel thread block. The orchestration is still callbacks.
Asyncc.ParallelLimit(8, fetchTasks, (err, results) -> {
  // ...
});
{% endhighlight %}

    <p style="margin-top: 24px; color: var(--fg-muted); font-size: 15px;">For the full Loom-integration story —
      structured concurrency vs. callbacks, <code>ThreadLocal</code> vs <code>ScopedValue</code>, why <code>NeoLock</code>
      is still relevant — see the <a href="{{ site.repo_url }}/blob/main/readme.md#project-loom-and-asyncjava">README's Project Loom section</a>.</p>
  </div>
</section>

<section class="section section--quiet">
  <div class="container">
    <p class="section__title">Recent posts</p>
    <h2 class="section__heading">From the engineering log.</h2>
    <ul class="post-list" style="margin-top: 32px;">
      {% for post in site.posts limit:5 %}
        <li class="post-card">
          <div class="post-card__date">{{ post.date | date: "%B %-d, %Y" }}</div>
          <a class="post-card__title" href="{{ post.url | relative_url }}">{{ post.title }}</a>
          {% if post.subtitle %}<p class="post-card__subtitle">{{ post.subtitle }}</p>{% endif %}
        </li>
      {% endfor %}
    </ul>
    <p style="margin-top: 28px;"><a class="btn btn--ghost" href="{{ '/blog/' | relative_url }}">All posts &rarr;</a></p>
  </div>
</section>
