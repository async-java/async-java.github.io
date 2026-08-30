// @ts-check
import { defineConfig } from "astro/config";

const site = process.env.PUBLIC_SITE_URL ?? "https://async-java.github.io";

export default defineConfig({
  site,
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
  },
});
