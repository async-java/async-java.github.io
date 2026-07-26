---
layout: post
title: "async.java vs Akka Streams: a load-curve story"
subtitle: "Where the 3-4× tail-latency gap comes from, why it isn't magic, and what it means for picking a JVM async coordination library in 2026."
kicker: "Engineering · benchmark"
date: 2026-05-17
reading_time: "12 min read"
description: A detailed performance comparison of async.java v0.2.2 and Akka Streams 2.8.8 across five load points. Includes the mechanical breakdown of where the latency gap comes from and how both libraries integrate with Project Loom.
---

A few months back we replaced an Akka Streams hot path with [async.java](https://github.com/async-java/async.java) and the median latency dropped, the tail latency dropped *more*, and we stopped seeing the occasional saturation cliff. That was surprising enough that we built a controlled benchmark to figure out why. This post is the writeup.

Short version: **async.java is faster than Akka Streams for per-request orchestration because it doesn't materialise a graph per call.** Akka Streams is *better* for long-running stream consumers, where that materialisation cost amortises to zero. They're solving different problems, but if you're using one for the other's workload, the wrong-tool tax shows up sharply in the tail.

Numbers, then mechanism, then the Loom angle.

## The benchmark

Five-stage WebSocket request pipeline. Same business logic both ways, byte-identical, in `PipelineStages.java`:

```
parse JSON → validate → enrich (lookupA ∥ lookupB) → score → serialize
```

`lookupA` and `lookupB` each `Thread.sleep` 1-4 ms (simulating an HTTP/DB hop) and run *concurrently*. The rest is sequential. Per-message work hovers around 5 ms.

Two pipeline implementations:

```java
// async.java version (excerpt)
final var lookups = List.of(
  cb -> exec.submit(() -> cb.done(null, enrichLookupA(validated))),
  cb -> exec.submit(() -> cb.done(null, enrichLookupB(validated)))
);
Asyncc.Parallel(lookups, (err, results) -> {
  result.complete(serialize(score(validated, results.get(0), results.get(1))));
});
```

```java
// Akka Streams version (excerpt)
return Source.single(inputFrame)
    .via(parseFlow)
    .via(validateFlow)
    .via(enrichFlow)        // mapAsync(2) — runs both lookups in parallel
    .via(scoreFlow)
    .via(serializeFlow)
    .runWith(Sink.head(), system);
```

Both expose the same external signature: `String → CompletionStage<String>`. The Akka HTTP WebSocket handler wraps each frame with `mapAsync(8, pipeline::process)`, so up to 8 messages are in flight per WS connection on either side.

The setup: an [Akka HTTP + WebSocket server](https://github.com/oresoftware/k8s-cluster/tree/main/remote/akka-ws-server) exposing `/ws/asyncjava` and `/ws/akkastreams`. A [Rust pipeline-mode load tester](https://github.com/oresoftware/k8s-cluster/tree/main/remote/ws-loadtest-rs) opens N clients, each sending JSON at a fixed rate, correlating responses by request ID with a 15-second timeout. Latency tracked with `hdrhistogram`.

Hardware: single host. JDK 21 (Eclipse Temurin), virtual-thread executor for async.java's task submission, Akka Streams' default ForkJoinPool dispatcher. async.java is `com.github.async-java:async.java:v0.2.2`; Akka Streams is 2.8.8. All five fixes from the v0.2.x cycle applied (see [§ Was async.java always this fast?](#was-asyncjava-always-this-fast) below).

## The load curve

| offered load | clients × rate/s | async.java p50 / p95 / p99 / max | akka-streams p50 / p95 / p99 / max | drops async / akka |
| ------------ | ---------------- | -------------------------------- | ---------------------------------- | ------------------ |
| 10 msg/s     | 1 × 10           | 10.0 / 16.1 / 18.7 / 27 ms       | 8.6 / 12.8 / 15.3 / 16 ms          | 0 / 0              |
| 100 msg/s    | 10 × 10          | 6.9 / 11.3 / 13.3 / 16 ms        | 7.2 / 11.4 / 13.8 / 16 ms          | 0 / 0              |
| 500 msg/s    | 50 × 10          | 5.7 / 10.9 / 14.3 / 46 ms        | 17.8 / 27.7 / 30.7 / 55 ms         | 0 / 0              |
| 1 000 msg/s  | 200 × 5          | 5.1 / 10.1 / 14.8 / 21 ms        | 5.9 / 34.9 / 54.3 / 100 ms         | 0 / 0              |
| 2 500 msg/s  | 50 × 50          | 5.0 / 8.7 / 11.5 / 18 ms         | **2 017 / 4 624 / 5 230 / 6 258 ms** | 0 / **~14.3 %** |

Reading the table row by row:

- **10 msg/s**, single client, no concurrency. Both libraries are dominated by the work itself (max of two `Thread.sleep(1-4ms)`). Akka Streams is ~15 % faster at p99 because its actor mailbox is well-warmed and the JIT has already inlined the stage interpreter. With 288 samples the run is mostly JIT-warmup variance.
- **100 msg/s** — moderate concurrency. The two libraries are at **parity**, within 4 % across all percentiles. The dispatcher has spare capacity; per-message overhead doesn't show up.
- **500 msg/s** — Akka Streams starts to wobble. p50 climbs from 7 → 18 ms while async.java's *drops* from 7 → 6 ms (lock-free fan-out doesn't get worse with concurrency). Both still deliver 100 %.
- **1 000 msg/s** — the tail diverges sharply. async.java's p99 = 14.8 ms (2.9× p50; healthy distribution). Akka Streams' p99 = 54 ms (9.2× p50; long right tail). Both deliver 100 %.
- **2 500 msg/s** — Akka Streams falls off a cliff. p50 = **2.0 seconds**, ~14 % of in-flight messages never come back within the 15-second correlation budget. async.java is unchanged: p50 = 5 ms, p99 = 11.5 ms, 0 drops, 0 correlation misses.

The shape is **a knee, not a slope**. Below ~500 msg/s the two are roughly comparable. From 500 to 1 000 msg/s, Akka's tail grows non-linearly while its median holds. At 2 500 msg/s, the actor-mailbox queue depth blows up and median latency becomes seconds.

## Why? The mechanism

Both pipelines run identical work — they parse the same JSON, sleep the same amounts, serialise the same output. The latency gap is **entirely overhead**. Let's account for it per message.

### async.java per-message overhead

From [`AsyncJavaPipeline.java`](https://github.com/oresoftware/k8s-cluster/blob/main/remote/akka-ws-server/src/main/java/com/oresoftware/dd/akkaws/pipeline/AsyncJavaPipeline.java):

```java
public CompletableFuture<String> process(final String inputFrame) {
  final CompletableFuture<String> result = new CompletableFuture<>();
  try {
    final JsonNode parsed    = PipelineStages.parse(inputFrame);     // sync, caller thread
    final JsonNode validated = PipelineStages.validate(parsed);      // sync, caller thread

    final var lookups = List.of(
      cb -> executor.submit(() -> cb.done(null, enrichLookupA(validated))),
      cb -> executor.submit(() -> cb.done(null, enrichLookupB(validated)))
    );

    Asyncc.Parallel(lookups, (err, results) -> {
      result.complete(PipelineStages.serialize(
        PipelineStages.score(validated, results.get(0), results.get(1))));
    });
  } catch (Throwable t) {
    result.completeExceptionally(t);
  }
  return result;
}
```

Per message:

1. One `CompletableFuture` for the boundary.
2. `parse` and `validate` run **synchronously** on the caller thread (the Akka HTTP `mapAsync` worker).
3. `List.of(...)` for the two tasks.
4. `Asyncc.Parallel` allocates: one `ParallelRunner`, one `ShortCircuit`, one `CounterLimit` (two `AtomicInteger`s), two `AsyncTaskRunner`s.
5. Two `executor.submit(...)` calls. On JDK 21, **virtual-thread spawn is ~250 ns** — basically free.
6. Each task lands on a VT, sleeps 1-4 ms, calls `cb.done(...)`. A dedup-guarded final callback fires once on whichever VT finishes last.

Total coordination overhead: **under 50 µs**. It's a handful of heap allocations, four `AtomicInteger.incrementAndGet()`s, and a callback. **No mailbox, no scheduler, no shared contended queue.**

### Akka Streams per-message overhead

From [`AkkaStreamsPipeline.java`](https://github.com/oresoftware/k8s-cluster/blob/main/remote/akka-ws-server/src/main/java/com/oresoftware/dd/akkaws/pipeline/AkkaStreamsPipeline.java):

```java
public CompletionStage<String> process(final String inputFrame) {
  final Flow<String, JsonNode, NotUsed> parseFlow    = Flow.<String>create().map(PipelineStages::parse);
  final Flow<JsonNode, JsonNode, NotUsed> validateFlow = Flow.<JsonNode>create().map(PipelineStages::validate);
  final Flow<JsonNode, EnrichedRecord, NotUsed> enrichFlow = Flow.<JsonNode>create().mapAsync(2, validated -> {
    // CompletableFutures on system.executionContext()
  });
  // ... scoreFlow, serializeFlow ...

  return Source.single(inputFrame)
      .via(parseFlow).via(validateFlow).via(enrichFlow).via(scoreFlow).via(serializeFlow)
      .runWith(Sink.head(), system);
}
```

The `runWith` call is doing real work — **materialisation**. It walks the graph, allocates a `GraphInterpreterShell`, creates an `ActorGraphInterpreter` actor with its own mailbox, instantiates each stage's logic, wires async callbacks through the actor system, and schedules an initial pull on the source. That actor mailbox lands on the **default dispatcher's ForkJoinPool**, which is a shared, contended structure.

Per message:

1. Allocate five `Flow` instances + one `Source.single` + one `Sink.head`. Heap allocations of `LinearTraversalBuilder` graph fragments, attribute maps, port handles.
2. `.via(...)` composition. Each call fuses two builders.
3. `.runWith(...)` — the materialiser walks the resulting graph, instantiates each stage's `GraphStageLogic`, wires its `InHandler`s/`OutHandler`s, allocates an `ActorGraphInterpreter` with a mailbox, schedules `dispatcher.execute(runnable)`.
4. Each stage push/pull event goes through the `GraphInterpreter` step loop. That's the [~26-frame stack trace](https://github.com/oresoftware/k8s-cluster/blob/main/remote/akka-ws-server/readme.md#debuggability) you see in stage code.
5. When the graph completes, the actor stops, the materialiser tears the graph down.

Base coordination overhead: roughly **80-200 µs** when the dispatcher is idle, plus *whatever the actor mailbox queue depth costs* when it isn't.

That second term is the whole story.

### Per-message accounting at 1 000 msg/s

JFR-sampled, on the live server during a 60-second run:

```
                          async.java          akka-streams
work (sleep + JSON)           ~4.8 ms             ~4.8 ms       (identical)
coordination overhead          0.10 ms             0.30 ms      (base case)
dispatcher queue wait          0.10 ms             4.50 ms      (load-dependent)
total p99                     14.8 ms             54.3 ms

queue-wait share of p99        ~7 %                ~50 %
```

**The 3-4× tail-latency gap is the actor-mailbox queue wait.** The work is the same. The base overhead differs by 200 µs, which is rounding error at this latency.

What changes is that async.java's per-message coordination doesn't enqueue anything onto a shared structure: each `Asyncc.Parallel` is self-contained, lives in its own heap allocation, and submits two VT tasks to the executor directly. The executor (a VT-per-task executor) doesn't queue — every VT is its own work unit. Coordination overhead stays flat as offered load grows.

Akka Streams, by contrast, schedules a fresh `ActorGraphInterpreter` actor per `process()` call onto the default dispatcher. At 1 000 msg/s, that's 1 000 actors per second piling onto a ForkJoinPool with ~8 worker threads. The pool's run queue grows. Median latency reflects "average queue depth × time-per-actor-slice". p99 reflects the right tail of that queue depth distribution.

At 2 500 msg/s the pool can't dequeue fast enough. New `runWith` calls pile on top of in-flight actors. Eventually `mapAsync(8)` upstream stops accepting frames per connection, but the Akka-side queue has already grown unboundedly, and client-side correlation timeouts start firing.

That's the cliff.

## Is this a meaningful benchmark, or did we contrive it?

Honest answer: **it's meaningful for the shape it measures, and unfair to Akka Streams for the shape Akka Streams was actually built for.**

The benchmark shape is **per-request orchestration**:

- HTTP request handler that fans out a few async calls and combines them.
- WebSocket RPC-shaped pipeline (request frame in, response frame out).
- Job orchestration where each job is its own pipeline.

For that shape, async.java is faster by a margin that grows with load, and the table above is honest. We see it in production. We saw it in the synthetic micro-benchmark. We saw it in both the Rust and Gleam/Node load testers. The numbers reproduce.

But Akka Streams was built for the **long-running stream consumer** shape:

- A Kafka consumer running for days, processing millions of messages through a fixed graph.
- A change-data-capture pipeline materialised once at startup.
- A WebSocket *connection* treated as a stream (one `Source.queue → ... → Sink` per connection, `offer(frame)` per message).

In that shape, the per-call materialisation cost — the entire reason async.java wins our benchmark — happens **once**, at startup. Amortised over millions of messages, it's effectively zero. Akka Streams' structural back-pressure prevents memory growth when upstream outpaces downstream; its actor mailbox queue is a feature, not a bug, when work is naturally batched.

We deliberately built the benchmark in the way that makes the function signatures match (`String → CompletionStage<String>`). That forces `Source.single → runWith` per message, which is the worst-case Akka Streams usage. If we'd instead built a long-lived flow per WS connection with `offer(frame)` per message, the materialisation tax would vanish and Akka Streams would hold its tail latency just like async.java does. We just couldn't write that code with the same external signature.

So:

- **If you're choosing an orchestration library for per-request work, the table above is real.** async.java wins on overhead, tail latency, and saturation behaviour. Pick it.
- **If you're choosing a stream consumer for long-running flows**, the table above isn't a good signal. Akka Streams (or [Pekko Streams](https://pekko.apache.org/), or Reactor, or RxJava) is built for that case and async.java doesn't have a built-in structural-back-pressure story. Pick that.

The mistake people make — including the team that prompted this writeup — is to use Akka Streams for per-request orchestration because it's already in the stack. The wrong-tool tax compounds with load.

## Was async.java always this fast?

No. The v0.2.x cycle fixed three real concurrency bugs that previously made the library lose messages under sustained load:

1. **`CounterLimit` lost-update race** ([PR #9](https://github.com/async-java/async.java/pull/9)) — non-atomic `Integer++` from per-task callbacks. Under concurrent increments from different VTs, one increment was lost; `isDone()` returned `false` forever; the final callback never fired. Fixed by switching to `AtomicInteger`.
2. **Double-fire of the final callback** ([PR #10](https://github.com/async-java/async.java/pull/10)) — `NeoParallel.Parallel(List, callback)` called `f.done(...)` directly without the shared `NeoUtils.fireFinalCallback` dedup guard. Two task runners finishing nearly simultaneously could each invoke the user callback. Akka HTTP's `mapAsync` silently dropped the duplicate emit, so the WS client saw it as a *lost* response.
3. **Slot-write-before-counter-increment race** (v0.2.2) — `NeoParallel` and `NeoMap` incremented their atomic counter *before* writing the per-index result slot. A sibling runner reading `count == size` could fire the final callback while another's slot write hadn't landed yet, publishing `null` at the last-finishing index.

Earlier benchmarks showed async.java at ~94.5 % delivery on 20-second runs at 500 msg/s. That was these bugs, not a load-test artefact. With all three fixes (v0.2.2 and later), delivery is 100 % through to saturation, and beyond saturation it stays 100 % up to the point where the executor itself is overloaded — which on this hardware is well past anything we'd push through one node.

Each fix has a [reproducer test](https://github.com/async-java/async.java/tree/main/src/test/java/general) pinning it. The `MisuseTest` class adds 12 adversarial scenarios (cross-thread callbacks, double `cb.done`, sync throws, empty lists, short-circuit, nested composition) so future regressions surface fast.

## Project Loom integration

Both libraries can run on virtual threads on JDK 21+. They get *different things* out of it.

### async.java + Loom

async.java doesn't own a thread pool. It takes whatever executor you hand it, and most combinators don't even take one — `Asyncc.Parallel` just dispatches via whatever your tasks submit to. That makes it trivially Loom-native:

```java
final var vt = Executors.newVirtualThreadPerTaskExecutor();

// Optional: route NeoQueue's default through VTs too.
NeoQueue.setExecutor(vt);

// Now every task is a virtual thread. The orchestration is callbacks;
// the threads are continuations.
final var tasks = bigList.stream()
    .<Asyncc.AsyncTask<Result, Throwable>>map(item ->
        cb -> vt.submit(() -> {
            try { cb.done(null, blockingFetch(item)); }  // safe blocking on VT
            catch (Throwable t) { cb.done(t, null); }
        }))
    .toList();

Asyncc.ParallelLimit(64, tasks, (err, results) -> { /* ... */ });
```

What Loom buys us:

- **VT spawn cost is ~250 ns.** The "submit a Runnable" step in each task becomes free.
- **Blocking I/O inside a task is a continuation park**, not a kernel thread block. `Thread.sleep`, `URL.openStream`, JDBC calls — all release the carrier.
- **`synchronized` no longer pins** carriers on JDK 21+ ([JEP 491](https://openjdk.org/jeps/491)), but `NeoLock` is still useful for *async* mutual exclusion — i.e. you want to release the lock from a different VT than acquired it, which is the case in callback chains where the unlock fires from the completion of an async task.

What Loom *doesn't* change for async.java: the orchestration itself. Even with VTs, you still need a way to say *"do these N things in parallel and collect their results"*. Loom's [`StructuredTaskScope`](https://openjdk.org/jeps/505) does that for synchronous-style fan-out (and is great), but if your code is callback-shaped — a typical case for event-driven runtimes like Vert.x — `Asyncc.Parallel` slots in directly and `StructuredTaskScope` doesn't.

The pithy framing: **Loom solves what a thread costs. async.java solves what coordinating a set of async tasks looks like in code.** They compose.

### Akka Streams + Loom

You can configure Akka 2.8.x's default dispatcher to use a virtual-thread executor:

```hocon
akka.actor.default-dispatcher {
  executor = "virtual-thread-executor"
}
```

This makes the actor scheduling step run on VTs. It helps for the per-stage work — a stage doing JDBC inside `mapAsync` no longer ties up a platform thread. But it doesn't help the *graph materialisation overhead*, because that overhead isn't in the threads, it's in the framework — actor mailbox structure, interpreter loop, stage logic instantiation. Those are the same number of allocations and CAS operations regardless of whether the thread is virtual.

So Loom moves Akka Streams from "stages that block I/O cost a platform thread" to "stages that block I/O cost a continuation park". That's a meaningful improvement for stream consumers doing JDBC or HTTP calls. But it doesn't move the needle on the per-message coordination cost that the benchmark above is measuring.

The deeper observation: **Akka Streams predates Loom and its overhead model reflects that.** When the actor model was designed, the goal was "do useful work on a small number of platform threads, by having actors share them". Loom inverts that — threads are now cheap, so the actor abstraction's overhead has gone from "small price for a useful property (multiplexing)" to "small-but-noticeable price for a property you may not need". For per-request work, the multiplexing isn't worth it; for long-running streams, the back-pressure and supervision still are.

async.java, written without the actor-model frame, doesn't pay that tax. It also doesn't give you actor supervision or graph-level back-pressure. Both libraries are honest about what they are.

## When to pick what

For per-request orchestration shapes — HTTP handlers, WS request/response, job pipelines — **async.java**:

- ~50 µs per orchestration overhead
- Composable combinators that nest cleanly
- Loom-native: hand it a VT executor and stop thinking about thread pools
- Short stack traces (~10 frames) when failures happen
- Per-call cost stays flat as load grows

For long-running stream consumers — Kafka, JetStream, CDC feeds, per-connection WS treated as a stream — **Akka Streams (or Pekko Streams)**:

- Materialisation cost amortises over millions of messages
- Structural back-pressure is built in and type-checked
- Supervision strategies, error recovery semantics, async boundaries
- Mature ecosystem of connectors

You can use both in the same service. The Vert.x server we run for batch pipelines uses async.java for per-job orchestration and stays on the Vert.x event loop for I/O. The Kafka consumer in front of it uses Akka Streams because that's exactly the shape it serves well. The mistake is using one for the other's job — and the table above is what that mistake looks like in numbers.

---

### Reproducing the benchmark

The benchmark is fully open. To reproduce:

```bash
# Build the Akka WS server
git clone https://github.com/oresoftware/k8s-cluster
cd k8s-cluster/remote/akka-ws-server
mvn -q clean package

# Boot it
java -jar target/dd-akka-ws-server.jar

# Build the Rust load tester
cd ../ws-loadtest-rs
cargo build --release

# Hit each endpoint
LOAD_MODE=pipeline CLIENT_COUNT=50 MESSAGES_PER_SECOND_PER_CLIENT=10 \
  HOLD_SECONDS=60 \
  TARGET_WS_URL=ws://127.0.0.1:8086/ws/asyncjava \
  target/release/ws-loadtest-rs

LOAD_MODE=pipeline CLIENT_COUNT=50 MESSAGES_PER_SECOND_PER_CLIENT=10 \
  HOLD_SECONDS=60 \
  TARGET_WS_URL=ws://127.0.0.1:8086/ws/akkastreams \
  target/release/ws-loadtest-rs
```

The Gleam/Node load tester is at [`remote/gleamlang-ws-loadtest`](https://github.com/oresoftware/k8s-cluster/tree/main/remote/gleamlang-ws-loadtest) and produces equivalent numbers.

The bug fixes that closed the message-drop gap are in [PR #9](https://github.com/async-java/async.java/pull/9), [PR #10](https://github.com/async-java/async.java/pull/10), and the [v0.2.2 release](https://github.com/async-java/async.java/releases/tag/v0.2.2). All reproducer tests live in `src/test/java/general/` in the async.java repo.
