---
layout: default
title: Rx.NET → async.java translation
permalink: /rx-comparison/
description: Line-for-line translation of a 5-stage Rx.NET pipeline (Observable.Select / SelectMany / Zip / Catch) into async.java, in two flavors — callback-style with Asyncc.Waterfall + Asyncc.Parallel, and promise-style with AsyncFut.ParallelF. Plus an operator mapping table and an honest take on when async.java earns its keep over plain CompletableFuture.
---

<div class="container container--narrow" style="padding-top: 56px;" markdown="1">

<h1 style="font-family: var(--font-display); font-size: 36px; letter-spacing: -0.015em; margin: 0 0 12px;">Rx.NET to async.java, line-for-line</h1>

<p style="font-size: 18px; color: var(--fg-muted); margin: 0 0 32px;">
A real Rx.NET pipeline rewritten in async.java, two ways. Includes a side-by-side
operator-mapping table and an honest take on when async.java earns its keep over plain
<code>CompletableFuture</code>.
</p>

<p style="font-size: 16px; color: var(--fg-muted); margin: 0 0 32px;">
The runnable Java reference lives in
<a href="https://github.com/oresoftware/k8s-cluster/blob/main/remote/akka-ws-server/src/main/java/com/oresoftware/dd/akkaws/comparison/RxFiveStagesComparison.java"><code>RxFiveStagesComparison.java</code></a>
and is pinned by
<a href="https://github.com/oresoftware/k8s-cluster/blob/main/remote/akka-ws-server/src/test/java/com/oresoftware/dd/akkaws/comparison/RxFiveStagesComparisonTest.java"><code>RxFiveStagesComparisonTest</code></a>
(4 tests, including happy-path byte-identity and three failure-mode error-frame equivalences).
</p>

## The Rx.NET original

The F# pipeline (from
<a href="https://github.com/oresoftware/k8s-cluster/blob/main/remote/fsharp-ws-server/RxAdvanced.fs"><code>RxAdvanced.fs</code></a>):

{% highlight fsharp %}
let private rxFiveStages (inbound: IObservable<string>) : IObservable<string> =
    inbound.SelectMany(fun input ->
        let body : IObservable<string> =
            Observable
                .Return(input)
                .Select(fun s -> parse s)
                .Select(fun n -> validate n)
                .SelectMany(fun validated ->
                    let a =
                        Observable.Start(
                            (fun () -> enrichLookupA validated),
                            TaskPoolScheduler.Default)
                    let b =
                        Observable.Start(
                            (fun () -> enrichLookupB validated),
                            TaskPoolScheduler.Default)
                    Observable.Zip(
                        a, b,
                        fun lookupA lookupB ->
                            struct (validated, lookupA, lookupB)))
                .Select(fun (struct (validated, lookupA, lookupB)) ->
                    score validated lookupA lookupB)
                .Select(fun scored -> serialize scored)
                .Select(fun out -> sprintf "{\"ok\":true,\"result\":%s}" out)
        body.Catch(fun (ex: exn) ->
            Observable.Return(perMessageErrorFrame ex)))
{% endhighlight %}

Six `.Select` calls, one `.SelectMany` for the fan-out, one `.Catch` for the error funnel.
The inner subgraph is re-materialised per emission via the outer `.SelectMany`.

## Version 1 — callback-style with `Asyncc.Waterfall` + `Asyncc.Parallel`

Closest line-for-line equivalent. Each `.Select` becomes a Waterfall stage. The
`Observable.Zip(Observable.Start(...), Observable.Start(...))` pair becomes an
`Asyncc.Parallel(List.of(a, b), ...)`. The `.Catch` becomes the Waterfall's terminal `err`
branch.

{% highlight java %}
public static CompletableFuture<String> runWaterfall(final String inputFrame, final Executor exec) {
    final CompletableFuture<String> outcome = new CompletableFuture<>();
    final List<NeoWaterfallI.AsyncTask<Object, Throwable>> stages = new ArrayList<>();

    // .Select(fun s -> parse s)
    stages.add(c -> {
        try { c.success("parsed", PipelineStages.parse(inputFrame)); }
        catch (Throwable t) { c.fail(t); }
    });

    // .Select(fun n -> validate n)
    stages.add(c -> {
        try { c.success("validated", PipelineStages.validate((JsonNode) c.get("parsed"))); }
        catch (Throwable t) { c.fail(t); }
    });

    // .SelectMany(fun validated -> Zip(Start(enrichA), Start(enrichB)))
    stages.add(c -> {
        final JsonNode validated = (JsonNode) c.get("validated");
        // List<Asyncc.Task<String>> flows directly into Parallel thanks to v0.2.8-rc2's
        // `List<? extends AsyncTask<T, E>>` widening — no cast, no defensive copy.
        final List<Asyncc.Task<String>> lookups = List.of(
            inner -> exec.execute(() -> {
                try { inner.success(PipelineStages.enrichLookupA(validated)); }
                catch (Throwable t) { inner.fail(t); }
            }),
            inner -> exec.execute(() -> {
                try { inner.success(PipelineStages.enrichLookupB(validated)); }
                catch (Throwable t) { inner.fail(t); }
            }));
        Asyncc.<String, Throwable>Parallel(lookups, (err, results) -> {
            if (err != null) { c.fail(err); return; }
            c.success("lookups", new ArrayList<>(results));
        });
    });

    // .Select(fun (v, a, b) -> score v a b)
    stages.add(c -> {
        try {
            final JsonNode validated = (JsonNode) c.get("validated");
            @SuppressWarnings("unchecked")
            final List<String> lookups = (List<String>) c.get("lookups");
            c.success("scored", PipelineStages.score(validated, lookups.get(0), lookups.get(1)));
        } catch (Throwable t) { c.fail(t); }
    });

    // .Select(fun scored -> serialize scored)
    stages.add(c -> {
        try { c.success("serialized", PipelineStages.serialize((JsonNode) c.get("scored"))); }
        catch (Throwable t) { c.fail(t); }
    });

    // .Select(fun out -> sprintf "{\"ok\":true,\"result\":%s}" out)
    stages.add(c ->
        c.success("envelope", "{\"ok\":true,\"result\":" + c.get("serialized") + "}"));

    // body.Catch(fun ex -> Observable.Return(perMessageErrorFrame ex))
    Asyncc.Waterfall(stages, (err, all) -> {
        if (err != null) { outcome.complete(perMessageErrorFrame(err)); return; }
        outcome.complete((String) all.get("envelope"));
    });
    return outcome;
}
{% endhighlight %}

## Version 2 — promise-style with `AsyncFut.ParallelF`

`AsyncFut.ParallelF` (v0.2.8-rc3+) accepts already-started `CompletionStage`s, so
`Observable.Start(fn, TaskPool)` maps directly to `CompletableFuture.supplyAsync(() -> fn(), exec)`
and `Observable.Zip(a, b)` maps to `AsyncFut.ParallelF(List.of(a, b))`.

{% highlight java %}
public static CompletableFuture<String> runWithAsyncFut(final String inputFrame, final Executor exec) {
    return CompletableFuture
        .completedFuture(inputFrame)
        .thenApply(s -> {                                                 // .Select(parse)
            try { return PipelineStages.parse(s); }
            catch (Exception e) { throw new RuntimeException(e); }
        })
        .thenApply(PipelineStages::validate)                              // .Select(validate)
        .thenCompose(validated ->                                         // .SelectMany + .Zip
            AsyncFut.<String>ParallelF(List.<CompletionStage<String>>of(
                CompletableFuture.supplyAsync(() -> PipelineStages.enrichLookupA(validated), exec),
                CompletableFuture.supplyAsync(() -> PipelineStages.enrichLookupB(validated), exec)
            )).thenApply(lookups -> new Object[] { validated, lookups.get(0), lookups.get(1) }))
        .thenApply(t ->                                                   // .Select(score)
            PipelineStages.score((JsonNode) t[0], (String) t[1], (String) t[2]))
        .thenApply(scored -> {                                            // .Select(serialize)
            try { return PipelineStages.serialize(scored); }
            catch (Exception e) { throw new RuntimeException(e); }
        })
        .thenApply(s -> "{\"ok\":true,\"result\":" + s + "}")             // .Select(envelope)
        .exceptionally(RxFiveStagesComparison::perMessageErrorFrame);     // .Catch
}
{% endhighlight %}

## Operator mapping

The same five-stage pipeline expressed in four orchestrators: F# Rx, async.java callbacks,
async.java promises, and Akka Streams. The Akka Streams column tracks the production
[`AkkaStreamsPipeline.java`](https://github.com/oresoftware/k8s-cluster/blob/main/remote/akka-ws-server/src/main/java/com/oresoftware/dd/akkaws/pipeline/AkkaStreamsPipeline.java)
shape that lives next to the async.java reference in `akka-ws-server`.

<div style="overflow-x: auto;">
<table style="margin: 24px 0; border-collapse: collapse; width: 100%; min-width: 980px; font-size: 14px;">
  <thead>
    <tr style="background: var(--bg-quiet); border-bottom: 2px solid var(--fg-muted);">
      <th style="text-align: left; padding: 10px; vertical-align: top;">Rx (F#)</th>
      <th style="text-align: left; padding: 10px; vertical-align: top;">async.java callback (Waterfall)</th>
      <th style="text-align: left; padding: 10px; vertical-align: top;">async.java promise (AsyncFut)</th>
      <th style="text-align: left; padding: 10px; vertical-align: top;">Akka Streams</th>
    </tr>
  </thead>
  <tbody>
    <tr style="border-bottom: 1px solid var(--bg-quiet);">
      <td style="padding: 10px; vertical-align: top;"><code>inbound.SelectMany(fun input -&gt; ...)</code></td>
      <td style="padding: 10px; vertical-align: top;">one <code>runWaterfall</code> call per inbound frame</td>
      <td style="padding: 10px; vertical-align: top;">one <code>runWithAsyncFut</code> call per inbound frame</td>
      <td style="padding: 10px; vertical-align: top;"><code>Source.single(input).via(flow).runWith(Sink.head(), system)</code> (per-message materialisation)</td>
    </tr>
    <tr style="border-bottom: 1px solid var(--bg-quiet);">
      <td style="padding: 10px; vertical-align: top;"><code>Observable.Return(input).Select(f)</code></td>
      <td style="padding: 10px; vertical-align: top;">Waterfall stage publishing <code>c.success(k, f(x))</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>.thenApply(f)</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>Flow.&lt;T&gt;create().map(f)</code></td>
    </tr>
    <tr style="border-bottom: 1px solid var(--bg-quiet);">
      <td style="padding: 10px; vertical-align: top;"><code>Observable.Start(fn, TaskPool)</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>exec.execute(() -&gt; try inner.success(fn()) catch inner.fail(t))</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>CompletableFuture.supplyAsync(() -&gt; fn(), exec)</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>CompletableFuture.supplyAsync(() -&gt; fn(), system.executionContext())</code> inside a <code>mapAsync</code> stage</td>
    </tr>
    <tr style="border-bottom: 1px solid var(--bg-quiet);">
      <td style="padding: 10px; vertical-align: top;"><code>Observable.Zip(a, b, combiner)</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>Asyncc.Parallel(List.of(a, b), (err, results) -&gt; combiner(results.get(0), results.get(1)))</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>AsyncFut.ParallelF(List.of(a, b)).thenApply(combiner)</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>.mapAsync(2, x -&gt; aFut.thenCombine(bFut, combiner))</code> &mdash; <em>or</em> a <code>Broadcast</code> + <code>Zip</code> subgraph</td>
    </tr>
    <tr style="border-bottom: 1px solid var(--bg-quiet);">
      <td style="padding: 10px; vertical-align: top;"><code>body.Catch(fun ex -&gt; errorFrame ex)</code></td>
      <td style="padding: 10px; vertical-align: top;">Waterfall's terminal <code>if (err != null) emitErrorFrame(err)</code> branch</td>
      <td style="padding: 10px; vertical-align: top;"><code>.exceptionally(errorFrame)</code></td>
      <td style="padding: 10px; vertical-align: top;"><code>.recover(ex -&gt; errorFrame(ex))</code> Flow stage (or a <code>Supervision.Strategy.resumingDecider</code> on the materialiser)</td>
    </tr>
    <tr>
      <td style="padding: 10px; vertical-align: top;"><em>Backpressure</em></td>
      <td style="padding: 10px; vertical-align: top;">not native &mdash; pair with <a href="/v/latest/org/ores/async/NeoQueue.html"><code>NeoQueue</code></a> for submission-side cap</td>
      <td style="padding: 10px; vertical-align: top;">not native &mdash; same: <code>NeoQueue</code> or <code>Semaphore</code>-style permits</td>
      <td style="padding: 10px; vertical-align: top;"><strong>structural</strong> &mdash; demand signal propagates upstream from the sink; <code>buffer(n, overflowStrategy)</code> tunes it per stage</td>
    </tr>
    <tr>
      <td style="padding: 10px; vertical-align: top;"><em>Per-pipeline overhead</em></td>
      <td style="padding: 10px; vertical-align: top;">~50 µs (heap allocs + atomic counter increments + lambda dispatch)</td>
      <td style="padding: 10px; vertical-align: top;">~50 µs + one <code>CompletableFuture</code> per stage</td>
      <td style="padding: 10px; vertical-align: top;">~200&ndash;400 µs per <em>materialisation</em> &mdash; see the <a href="{{ '/blog/2026/05/17/async-java-vs-akka-streams/' | relative_url }}">load-curve breakdown</a> for the source of the gap</td>
    </tr>
  </tbody>
</table>
</div>

## Honest take: when async.java earns its keep over plain `CompletableFuture`

For this **exact** pipeline (linear flow, 2-way fan-out, single error sink) the most
idiomatic Java answer is probably plain `CompletableFuture` with `.thenCombine(...)` instead
of `AsyncFut.ParallelF`. 2-way fan-out doesn't need a List-based combinator. The F# Rx
version is doing the same thing with extra ceremony, and writing the AsyncFut equivalent of
ceremony for ceremony's sake doesn't pay off.

async.java's value-add appears when **one or more** of these enters the picture:

1. **N parallel tasks, not 2.** `Asyncc.Parallel(List.of(t1, ..., tN))` or
   `ParallelLimit(k, List.of(...))` is a one-liner for arbitrary fan-out width. With
   `thenCombine` you'd be writing a `combine`-cascade.

2. **Bounded concurrency.** `ParallelLimit(4, tasks, ...)` caps in-flight work. Rx has
   `Merge(maxConcurrent: 4)`; plain `CompletableFuture` has no equivalent without writing
   your own semaphore. async.java's `ParallelLimit` is hardened by 100-iteration regression
   tests (v0.2.5 fixed an off-by-one in `RunTasksLimit`).

3. **Backpressure.** [`NeoQueue`](/v/latest/org/ores/async/NeoQueue.html) is a bounded async
   work queue with `saturated` / `unsaturated` / `drain` lifecycle hooks — the equivalent of
   Rx's `Buffer` / `Throttle` / `Window` for "accept submissions but cap concurrent
   execution".

4. **Shared-state coordination across pipelines.** [`NeoLock`](/v/latest/org/ores/async/NeoLock.html)
   and [`NeoRwLock`](/v/latest/org/ores/async/NeoRwLock.html) (v0.2.6) for cross-frame mutual
   exclusion. Rx has no native equivalent — you'd reach for `ReentrantLock` and live with the
   pinning.

5. **Composability of more exotic flow.** `Whilst`, `FilterMap`, `GroupBy`, `Reduce`, `Race`,
   `Inject` — Rx has these too, but async.java's callback contract is uniform across all of
   them, so they nest without conversion adapters. See the
   [composability showcase]({{ '/composability/' | relative_url }}) for an 11-combinator pipeline.

## Tests pinning the equivalence

The runnable Java reference is pinned by
[`RxFiveStagesComparisonTest.java`](https://github.com/oresoftware/k8s-cluster/blob/main/remote/akka-ws-server/src/test/java/com/oresoftware/dd/akkaws/comparison/RxFiveStagesComparisonTest.java):

* **Happy path:** Waterfall and AsyncFut versions produce **byte-identical** output for the same input.
* **Parse failure** (`"not json"`): both emit `{"ok":false,"error":"JsonParseException: ..."}` on the success channel of the returned future.
* **Validation failure** (missing `id`): both emit an `IllegalArgumentException`-typed error frame.
* **Score failure** (`id="poison"`): both emit an `IllegalStateException`-typed error frame, proving the error funnel works downstream of the fan-out — same observable behavior as Rx's `body.Catch` at the outer subgraph boundary.

Run them with:

{% highlight bash %}
mvn -pl remote/akka-ws-server test -Dtest=RxFiveStagesComparisonTest
{% endhighlight %}

</div>
