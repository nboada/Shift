import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://getshiftmail.com",
  // The dev toolbar runs scripts over the page and makes Lenis scrolling stutter in dev.
  devToolbar: { enabled: false },
  // privacy.html instead of privacy/index.html, so /privacy keeps working without a redirect.
  build: { format: "file" },
  // Lightning CSS folds animation-timeline into the animation shorthand, which browsers reject, killing the scroll animations.
  vite: { build: { cssMinify: false } },
});
