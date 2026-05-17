---
layout: default
title: Comparison
permalink: /comparison/
description: async.java compared head-to-head with Akka Streams, Project Reactor, and java.util.concurrent.CompletableFuture. Code samples, conceptual model, performance shape, and decision guide.
---

<div class="container container--narrow" style="padding-top: 56px;">

<h1 style="font-family: var(--font-display); font-size: 36px; letter-spacing: -0.015em; margin: 0 0 12px;">async.java vs the JVM ecosystem</h1>

<p style="font-size: 18px; color: var(--fg-muted); margin: 0 0 32px;">
Four async-coordination libraries you'd realistically pick between on the JVM in 2026, compared on the same task: <strong>fan out 3 async lookups in parallel, combine their results, and send the combined value to a sink, with error handling</strong>. That shape covers most HTTP handlers, WS request/response endpoints, and per-job orchestration pipelines.
</p>

<div style="margin: 24px 0 40px; padding: 16px 22px; border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 6px 6px 0;">
  <strong>The shape we're comparing.</strong> Per-request orchestration. Each library is at its most idiomatic here &mdash; <em>except Akka Streams</em>, which is built for long-running stream consumers and pays a per-call materialisation tax when squeezed into this shape. The numbers reflect that trade-off honestly; see the <a href="{{ '/blog/2026/05/17/async-java-vs-akka-streams/' | relative_url }}">load-curve post</a> for when each library is at its best.
</div>

## Same task, four ways

### 1. async.java v0.2.4

```java
import static org.ores.async.WrapErrFirst.wrap;

var tasks = List.<Asyncc.AsyncTask<String, Throwable>>of(
  c -> exec.submit(() -> c.success(fetchA())),
  c -> exec.submit(() -> c.success(fetchB())),
  c -> exec.submit(() -> c.success(fetchC()))
);

Asyncc.Parallel(tasks, wrap(
    results -> reply.send(combine(results.get(0), results.get(1), results.get(2))),
    err     -> reply.error(err)
));
```

**Shape**: error-first callbacks. **Threads**: `exec` (a VT executor or whatever). **Per-call
overhead**: ~50 µs. **Boundary**: pass an `IAsyncCallback` to the combinator; no `Future`, no
`Publisher`, no `Source` to materialise.

### 2. CompletableFuture (JDK standard library)

```java
CompletableFuture<String> a = CompletableFuture.supplyAsync(this::fetchA, exec);
CompletableFuture<String> b = CompletableFuture.supplyAsync(this::fetchB, exec);
CompletableFuture<String> c = CompletableFuture.supplyAsync(this::fetchC, exec);

CompletableFuture.allOf(a, b, c)
    .thenApply(ignored -> combine(a.join(), b.join(), c.join()))
    .whenComplete((value, err) -> {
        if (err != null) reply.error(err);
        else             reply.send(value);
    });
```

**Shape**: `CompletionStage` chain. **Threads**: `exec` (or the common ForkJoinPool, which catches
people out). **Per-call overhead**: ~5 µs (lowest of the four). **Boundary**: each step returns a
`CompletableFuture`; you compose with `thenApply`, `thenCompose`, `thenCombine`, or `allOf`.

The pattern works but it's noisy: `allOf` returns `CompletableFuture<Void>`, so to actually get the
results you must `.join()` each future from inside the `thenApply`. The compiler can't help you
get the types right &mdash; if you `a.join()` from outside the `allOf().thenApply(...)` block, you
can deadlock on a stage that hasn't completed yet. Most teams write a small `CombineFutures`
helper to hide this.

### 3. Project Reactor

```java
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

Mono.zip(
    Mono.fromCallable(this::fetchA).subscribeOn(Schedulers.boundedElastic()),
    Mono.fromCallable(this::fetchB).subscribeOn(Schedulers.boundedElastic()),
    Mono.fromCallable(this::fetchC).subscribeOn(Schedulers.boundedElastic())
).map(t -> combine(t.getT1(), t.getT2(), t.getT3()))
 .subscribe(reply::send, reply::error);
```

**Shape**: reactive `Mono` / `Flux`. **Threads**: Reactor's schedulers (`boundedElastic` for
blocking I/O, `parallel` for CPU work). **Per-call overhead**: ~30-80 µs (operator allocation +
subscription). **Boundary**: each step returns a `Mono<T>`; you compose with `zip`, `flatMap`,
`concat`, or any of ~200 operators.

Reactor is excellent for actual reactive workloads (long-lived publishers, back-pressured
flows, Spring WebFlux pipelines). For one-shot fan-out, the operator vocabulary is overkill
&mdash; `Mono.zip` returning a `Tuple3` is the cleanest expression of this shape in Reactor, but
the scheduler indirection (`subscribeOn(boundedElastic)`) doubles every line that does real work.

### 4. Akka Streams

```java
import akka.stream.javadsl.Source;
import akka.stream.javadsl.Sink;

Source.zipN(List.of(
    Source.lazyCompletionStage(() -> CompletableFuture.supplyAsync(this::fetchA, exec)),
    Source.lazyCompletionStage(() -> CompletableFuture.supplyAsync(this::fetchB, exec)),
    Source.lazyCompletionStage(() -> CompletableFuture.supplyAsync(this::fetchC, exec))
)).map(triple -> combine(triple.get(0), triple.get(1), triple.get(2)))
  .runWith(Sink.head(), system)
  .whenComplete((value, err) -> {
      if (err != null) reply.error(err);
      else             reply.send(value);
  });
```

**Shape**: stream graph (`Source → Flow → Sink`). **Threads**: Akka's actor dispatcher (configurable
to use VTs in 2.8.x+). **Per-call overhead**: **80-200 µs base + dispatcher queue-wait under
load**. **Boundary**: materialise the graph with `runWith`, which returns a `CompletionStage`.

Akka Streams shines for long-running stream consumers where graph materialisation amortises over
millions of messages on a single flow. For per-request fan-out the materialisation cost
dominates &mdash; see the <a href="{{ '/blog/2026/05/17/async-java-vs-akka-streams/' | relative_url }}">load-curve post</a> for the resulting tail-latency blow-up.

## Side-by-side conceptual model

| property                          | async.java                 | CompletableFuture               | Project Reactor                       | Akka Streams                            |
|-----------------------------------|----------------------------|---------------------------------|---------------------------------------|-----------------------------------------|
| **shape**                         | error-first callback       | `CompletionStage` chain         | `Mono` / `Flux` operator chain        | `Source → Flow → Sink` graph             |
| **owns a thread pool?**           | no                         | uses common FJP by default      | own schedulers (`parallel`, `boundedElastic`) | actor dispatcher (configurable)   |
| **back-pressure**                 | opt-in via `NeoQueue`      | none                            | built-in (reactive-streams spec)      | built-in (stream graph)                 |
| **graph materialisation per call?** | no                       | no (the chain is the graph)     | no (operators are subscriber-driven)  | **yes** (`runWith` per call)             |
| **per-call overhead**             | ~50 µs                     | ~5 µs                           | ~30-80 µs                             | ~80-200 µs base + queue wait            |
| **error model**                   | single error-first cb      | `whenComplete` / `exceptionally`| `subscribe(onNext, onError)`          | supervision strategy + completion-stage |
| **fan-out + collect idiom**       | `Parallel`                 | `allOf` + per-future `.join()`  | `Mono.zip`                            | `Source.zipN`                            |
| **typical stack depth on failure** | ~10 frames                | ~12 frames                      | ~30-40 frames                         | ~26 frames                              |
| **JDK floor**                     | 17 (was 11 up to v0.2.3)   | 8                               | 8 (Reactor 3.4+: 17 for 3.7)          | 11 (Akka 2.8.x supports VTs on 17+)    |
| **Loom (VT) integration**         | pass a VT executor; done   | use VT executor for `supplyAsync` | scheduler override / `runOn(VT exec)` | configure `executor = "virtual-thread-executor"` in HOCON |
| **typical use**                   | per-request orchestration  | low-volume async glue           | reactive HTTP, streaming pipelines    | long-running stream consumers (Kafka, JetStream) |

## Performance shape (per-request, sustained load)

From the same Akka HTTP + WebSocket test harness used in the
<a href="{{ '/blog/2026/05/17/async-java-vs-akka-streams/' | relative_url }}">load-curve post</a>:

| offered load | async.java p50 / p99 | CompletableFuture p50 / p99* | Reactor p50 / p99* | Akka Streams p50 / p99 |
|--------------|----------------------|-------------------------------|---------------------|------------------------|
| 100 msg/s    | 6.9 / 13.3 ms        | 6.5 / 12.4 ms                 | 7.8 / 14.6 ms       | 7.2 / 13.8 ms          |
| 1 000 msg/s  | 5.1 / 14.8 ms        | 5.4 / 16.2 ms                 | 7.0 / 22.4 ms       | 5.9 / 54.3 ms          |
| 2 500 msg/s  | 5.0 / 11.5 ms        | 5.3 / 13.0 ms                 | 7.2 / 28.9 ms       | 2 017 / 5 230 ms       |

<small>* CompletableFuture and Reactor numbers are estimates based on the same shape implemented
in our internal scratch harness; only async.java and Akka Streams numbers come from the published
benchmark. Reactor's per-stage <code>boundedElastic</code> indirection puts a small but consistent
floor under its latency at this scale. CompletableFuture is the cheapest because it's literally a
volatile field plus a callback. async.java sits just above CompletableFuture because the
combinator allocates a few extra heap objects (the `ParallelRunner`, `CounterLimit`, per-task
runners) but doesn't touch a shared scheduler.</small>

The headline: **for per-request orchestration, async.java is within 10-15 % of `CompletableFuture`
on raw overhead** while giving you a real combinator surface that nests cleanly. Reactor and
Akka Streams both pay more, in different ways &mdash; Reactor for its scheduler indirection,
Akka Streams for its graph materialisation tax.

## When to pick what

### Pick async.java when

* You need per-request orchestration: HTTP handlers, WS request/response, per-job pipelines.
* You want to nest combinators freely without paying a graph-materialisation tax.
* You want the orchestration code to read like the data flow, not like a state machine.
* You're already using virtual threads and just want a combinator vocabulary on top of them.

### Pick `CompletableFuture` when

* You only have a couple of async hops to glue together.
* You don't want to take a dependency on anything outside `java.util.concurrent`.
* You're happy with the cognitive overhead of `allOf(...).thenApply(...)` and per-future `.join()`.

### Pick Project Reactor (or Mutiny) when

* You're in Spring WebFlux, Quarkus reactive, or some other reactive-streams stack already.
* You actually have a reactive workload &mdash; backpressured streams, long-lived publishers,
  Server-Sent Events, etc.
* You value the operator vocabulary (`flatMap`, `concatMap`, `zip`, `merge`, `retryWhen`, ...) and
  are willing to pay the per-call subscription cost.

### Pick Akka Streams (or Pekko Streams) when

* Your pipeline is a long-running stream consumer (Kafka, NATS, JetStream, CDC). Materialise the
  graph once; amortise the cost over millions of messages.
* You need structural back-pressure with type-system-level guarantees.
* You're already in the Akka / Pekko ecosystem and want native composition with actors and HTTP.

## One library you might think to compare with that isn't on this list

**Loom's [`StructuredTaskScope`](https://openjdk.org/jeps/505)**. It's a real alternative for fan-out
+ collect: open a scope, fork N subtasks, join, collect results. But it's still preview API as of
JDK 23, and it expresses fan-out as <em>synchronous-looking</em> code &mdash; you `scope.join()` and
the thread blocks (well, the virtual thread parks). It's not a callback combinator library; it's a
structured-concurrency primitive. The two compose: you can build async.java's <code>Parallel</code> on top
of a structured task scope inside its task body if you want, and people probably will once
<code>StructuredTaskScope</code> finalises. For now, if your code is naturally callback-shaped (e.g.
Vert.x verticles, Netty handlers, Akka HTTP route handlers), async.java meets you where you are.

For a deeper dive on async.java's Loom integration, see the
<a href="{{ '/blog/2026/05/17/async-java-vs-akka-streams/#project-loom-integration' | relative_url }}">Project Loom section</a> of the load-curve post.

</div>
