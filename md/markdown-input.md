
<script src="https://cdn.rawgit.com/google/code-prettify/master/loader/run_prettify.js?autoload=true&lang=java"></script>

### This is title

<a name="abcde"></a>
<pre lang="java" class="prettyprint">

 class NeoEach {
   
   static <T, V, E> void Each(int limit, Iterable<T> i, Asyncc.IEacher<T, E> m, Asyncc.IEachCallback<E> f) {
     
     final CounterLimit c = new CounterLimit(limit);
     final ShortCircuit s = new ShortCircuit();
     final var iterator = i.iterator();
     RunEach(iterator, c, s, m, f);
     handleSameTickCall(s);
   }
   
 }
</pre>