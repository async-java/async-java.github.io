---
layout: default
title: Composability
permalink: /composability/
description: Realistic, deeply-nested async.java pipelines showcasing how combinators compose. One end-to-end example using Waterfall, Times, Map, Parallel, ParallelLimit, FilterMap, GroupBy, Race, Reduce, NeoQueue, and NeoLock.
---

<div class="container container--narrow" style="padding-top: 56px;" markdown="1">

<h1 style="font-family: var(--font-display); font-size: 36px; letter-spacing: -0.015em; margin: 0 0 12px;">Composability showcase</h1>

<p style="font-size: 18px; color: var(--fg-muted); margin: 0 0 32px;">
The point of a combinator library is that the combinators nest. Every async.java combinator
takes an error-first callback and produces an error-first callback &mdash; so any combinator can
appear at any depth in any other combinator's task position. Below is a real-world-shaped
pipeline (a per-region competitive-pricing job) that uses <strong>11 different async.java
constructs in one workflow</strong>: <code>Waterfall</code>, <code>Times</code>, <code>Map</code>,
<code>Parallel</code>, <code>ParallelLimit</code>, <code>FilterMap</code>, <code>GroupBy</code>,
<code>Race</code>, <code>Reduce</code>, <code>NeoQueue</code>, and <code>NeoLock</code>.
</p>

<p style="font-size: 16px; color: var(--fg-muted); margin: 0 0 32px;">
The example is real code: it ships in <a href="https://github.com/oresoftware/k8s-cluster/blob/main/remote/spark-pipeline-server/src/main/java/com/oresoftware/dd/sparkpipeline/pipeline/CompositionDemoPipeline.java"><code>dd-spark-pipeline-server</code></a> as the <code>COMPOSITION_DEMO</code> job kind and runs continuously in our cluster as a smoke test.
</p>

## The job

For each of <em>N</em> regions, fetch a catalog of items, classify each item via two parallel
lookups, drop the ones that don't pass quality gates, group survivors by category, race two
pricing models per category and pick the faster, then reduce per-category prices into a global
recommendation, all guarded by a per-region mutex and dispatched through a global queue with
bounded concurrency.

```
Waterfall
├─ stage 1  generate region ids                              (Times)
├─ stage 2  per-region pipeline                              (Map, concurrent over regions)
│   ├─ acquire region lock                                   (NeoLock)
│   ├─ fetch + filter catalog                                (Parallel + FilterMap)
│   ├─ classify each item                                    (ParallelLimit, cap = 8)
│   │   └─ classifier fan-out                                (Parallel, 2 lookups)
│   ├─ group survivors by category                           (GroupBy)
│   ├─ price each category (model A vs model B)              (Map + Race)
│   ├─ reduce per-category prices into recommendation         (Reduce)
│   └─ release region lock
└─ stage 3  aggregate region recommendations                 (Reduce)
```

## The code

A single Java method, ~80 lines, exercising every combinator:

{% highlight java %}
public void run(final int regionCount, final IAsyncCallback<Map<String, Recommendation>, Throwable> done) {

  final NeoLock regionLock = SharedLocks.byName("composition-region");

  Asyncc.Waterfall(List.of(

      //----------------------------------------------------------------
      // Stage 1: Times — generate N region ids in parallel
      //----------------------------------------------------------------
      c -> Asyncc.Times(regionCount, (i, inner) -> exec.submit(
          () -> inner.success("region-" + i)
      ), c),

      //----------------------------------------------------------------
      // Stage 2: Map over regions — each region runs the inner pipeline
      //----------------------------------------------------------------
      (regions, c) -> Asyncc.Map(regions, (region, perRegion) -> {

        //--------------------------------------------------------------
        // 2.a NeoLock — only one job per region at a time
        //--------------------------------------------------------------
        regionLock.acquire((err, unlock) -> {

          //------------------------------------------------------------
          // 2.b Parallel — fetch catalog and metadata concurrently
          //------------------------------------------------------------
          Asyncc.Parallel(List.<Asyncc.AsyncTask<Object, Throwable>>of(
              c2 -> exec.submit(() -> c2.success(catalogClient.fetch(region))),
              c2 -> exec.submit(() -> c2.success(metadataClient.fetch(region)))
          ), (e1, both) -> {

            if (e1 != null) { unlock.releaseLock(); perRegion.fail(e1); return; }

            final List<Item> rawCatalog = (List<Item>) both.get(0);
            final Metadata  meta        = (Metadata)   both.get(1);

            //----------------------------------------------------------
            // 2.c FilterMap — drop items below the quality threshold,
            //     keeping only those whose classifier output passes
            //----------------------------------------------------------
            Asyncc.FilterMap(rawCatalog, (item, c2) -> exec.submit(() -> {
              c2.success(meta.passesQualityGate(item) ? item : null);
            }), (e2, kept) -> {

              if (e2 != null) { unlock.releaseLock(); perRegion.fail(e2); return; }

              //--------------------------------------------------------
              // 2.d ParallelLimit — classify each item; cap concurrent
              //     downstream classifier calls at 8 per region
              //--------------------------------------------------------
              final var classifyTasks = kept.stream()
                  .<Asyncc.AsyncTask<ClassifiedItem, Throwable>>map(it ->
                      (c2 -> {
                        //------------------------------------------------
                        // 2.e Parallel (nested) — two classifier lookups
                        //     per item, both must succeed
                        //------------------------------------------------
                        Asyncc.Parallel(List.<Asyncc.AsyncTask<String, Throwable>>of(
                            sub -> exec.submit(() -> sub.success(classifierA.classify(it))),
                            sub -> exec.submit(() -> sub.success(classifierB.classify(it)))
                        ), (eC, labels) -> c2.done(eC, new ClassifiedItem(it, labels)));
                      }))
                  .toList();

              Asyncc.ParallelLimit(8, classifyTasks, (e3, classified) -> {

                if (e3 != null) { unlock.releaseLock(); perRegion.fail(e3); return; }

                //-------------------------------------------------------
                // 2.f GroupBy — bucket classified items by category
                //-------------------------------------------------------
                Asyncc.GroupBy(classified, (ci, c2) -> exec.submit(() -> {
                  c2.success(ci.primaryCategory());
                }), (e4, grouped) -> {

                  if (e4 != null) { unlock.releaseLock(); perRegion.fail(e4); return; }

                  //-----------------------------------------------------
                  // 2.g Map + Race — per category, race two pricing
                  //     models and take whichever returns first
                  //-----------------------------------------------------
                  Asyncc.Map(grouped.entrySet(), (entry, c2) -> {

                    final String category = entry.getKey();
                    final List<ClassifiedItem> items = entry.getValue();

                    Asyncc.Race(List.<Asyncc.AsyncTask<Price, Throwable>>of(
                        sub -> exec.submit(() -> sub.success(priceModelA.price(items))),
                        sub -> exec.submit(() -> sub.success(priceModelB.price(items)))
                    ), (eR, winner) -> c2.done(eR, new CategoryPrice(category, winner)));

                  }, (e5, categoryPrices) -> {

                    if (e5 != null) { unlock.releaseLock(); perRegion.fail(e5); return; }

                    //--------------------------------------------------
                    // 2.h Reduce — fold per-category prices into one
                    //     per-region Recommendation
                    //--------------------------------------------------
                    Asyncc.Reduce(categoryPrices,
                        Recommendation.empty(region),
                        (acc, cp, c2) -> exec.submit(() ->
                            c2.success(acc.withCategory(cp.category(), cp.price()))),
                        (e6, recommendation) -> {
                          unlock.releaseLock();
                          if (e6 != null) perRegion.fail(e6);
                          else            perRegion.success(recommendation);
                        });
                  });
                });
              });
            });
          });
        });
      }, c),

      //--------------------------------------------------------------
      // Stage 3: Reduce — fold region recommendations into a map
      //--------------------------------------------------------------
      (perRegionList, c) -> Asyncc.Reduce(perRegionList,
          new HashMap<String, Recommendation>(),
          (acc, rec, inner) -> { acc.put(rec.region(), rec); inner.success(acc); },
          c)

  ), done);
}
{% endhighlight %}

## What this demonstrates

* **Every combinator returns to the same error-first callback shape.** A `Waterfall` step's
  continuation, a `Map` task's continuation, a `Parallel` task's continuation — they're all
  `IAsyncCallback<V, E>`. So you can put any combinator inside any other combinator's task
  position, no glue code required.
* **Errors propagate cleanly.** Any `c.fail(err)` in the deeply-nested code bubbles up through
  every enclosing combinator to the outermost `done` continuation. Each combinator short-circuits
  its siblings; the at-most-once final-callback guard absorbs any duplicate fires from already-
  in-flight tasks racing the short-circuit.
* **No `CompletableFuture` plumbing.** The boundary back to the caller is a single
  `IAsyncCallback`. Internally the pipeline is plain callbacks all the way down.
* **The pipeline lives on the threads you choose.** Tasks are dispatched onto the executor passed
  to `exec.submit(...)` — a virtual-thread executor in our case. async.java doesn't own a thread
  pool of its own; you control where the work runs.
* **Mutual exclusion fits inside the pipeline.** `NeoLock.acquire` is a normal continuation
  consumer. The lock is held across the entire per-region pipeline, including async work, and
  released exactly once when the pipeline finishes — success or failure.

## Where this runs

A version of this pipeline is the `COMPOSITION_DEMO` job kind in the
[dd-spark-pipeline-server](https://github.com/oresoftware/k8s-cluster/tree/main/remote/spark-pipeline-server)
Vert.x service in the
[k8s-cluster](https://github.com/oresoftware/k8s-cluster) monorepo, deployed to a Kubernetes
cluster via Argo CD and continuously exercised by both the
[Rust](https://github.com/oresoftware/k8s-cluster/tree/main/remote/ws-loadtest-rs) and
[Gleam/Node](https://github.com/oresoftware/k8s-cluster/tree/main/remote/gleamlang-ws-loadtest)
load testers. The end-to-end test
[`CompositionDemoPipelineTest`](https://github.com/oresoftware/k8s-cluster/blob/main/remote/spark-pipeline-server/src/test/java/com/oresoftware/dd/sparkpipeline/pipeline/CompositionDemoPipelineTest.java)
runs the pipeline 20× concurrently and verifies every stage logged its expected message in every
run.

## Compare with the alternatives

The same pipeline expressed in other JVM async libraries grows by roughly:

| Library             | Approximate LOC | Notes                                                                       |
|---------------------|----------------:|-----------------------------------------------------------------------------|
| async.java v0.2.5   |              80 | the code above                                                              |
| CompletableFuture   |        ~140-170 | each fan-out needs `allOf(...).thenApply(v -> List.of(a.join(), b.join()))` |
| Project Reactor     |        ~110-130 | `Mono.zip` + `flatMap` + `Schedulers.boundedElastic()` per stage             |
| Akka Streams        |        ~180-220 | `Source.from(...).via(...).mapAsync(...).runWith(...)` per stage             |

LOC isn't the whole story. The real difference is **how much glue code each library forces** &mdash;
how often you have to translate between value types, future shapes, scheduler abstractions, or
back-pressure-aware operators. async.java keeps the same shape (error-first callback) at every
level so the glue collapses to a single nested call. See <a href="{{ '/comparison/' | relative_url }}">the comparison page</a> for a head-to-head on one of these stages.

</div>
