---
layout: default
title: Blog
permalink: /blog/
description: Engineering posts about async.java — performance, design, comparisons with other JVM orchestration libraries.
---

<div class="blog-index container container--narrow">
  <h1 class="blog-index__heading">Blog</h1>
  <p class="blog-index__lede">Engineering posts about async.java — performance, design, comparisons with other JVM orchestration libraries, and how the library fits with Project Loom.</p>
  <ul class="post-list">
    {% for post in site.posts %}
      <li class="post-card">
        <div class="post-card__date">{{ post.date | date: "%B %-d, %Y" }}</div>
        <a class="post-card__title" href="{{ post.url | relative_url }}">{{ post.title }}</a>
        {% if post.subtitle %}<p class="post-card__subtitle">{{ post.subtitle }}</p>{% endif %}
      </li>
    {% endfor %}
  </ul>
</div>
