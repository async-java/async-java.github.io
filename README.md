# async-java.github.io

Source for [async-java.github.io](https://async-java.github.io) — the docs site for
[async.java](https://github.com/async-java/async.java).

This is a Jekyll site. GitHub Pages auto-builds it from `master`.

## Local development

```bash
bundle install
bundle exec jekyll serve --livereload
```

Then open <http://127.0.0.1:4000/>.

## Layout

- `index.md` — landing page
- `examples.md` — one snippet per combinator
- `blog.md` — blog index (lists `_posts/`)
- `_posts/` — blog posts
- `_layouts/`, `_includes/`, `assets/css/` — theme
- `v/<version>/` — versioned javadoc snapshots, served as static assets

## Adding a blog post

Drop a markdown file in `_posts/` named `YYYY-MM-DD-slug.md` with this front matter:

```yaml
---
layout: post
title: "Your title"
subtitle: "Optional one-line subtitle."
kicker: "Engineering · category"
date: 2026-MM-DD
reading_time: "N min read"
description: SEO description
---
```

GitHub Pages will rebuild on push to `master`.
