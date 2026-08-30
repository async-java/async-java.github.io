# async-java.github.io

The public Astro marketing site for **Async Java**.

Compositional asynchronous control flow for Java, with Vert.x, Akka, futures, and reactive variants.

The former Jekyll sources remain in Git as historical material. Maintained API documentation lives in the organization's dedicated `async-docs` repository.

## Development

Use Node.js 22.22.1 or newer.

```sh
npm ci
npm run dev
npm run build
```

Astro writes the production site to `dist/`. The committed GitHub Actions workflow builds pull requests and deploys the default branch to GitHub Pages.

## Content standard

Public claims must remain traceable to the organization's repositories, documentation, or planning context. Do not publish credentials, customer data, private operational details, or unreviewed legal language from this public repository.
