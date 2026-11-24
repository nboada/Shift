import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// One Markdown file per release in src/content/changelog, written for people who use Shift.
const changelog = defineCollection({
  loader: glob({ base: "./src/content/changelog", pattern: "*.md" }),
  schema: z.object({
    version: z.string(),
    date: z.coerce.date(),
    title: z.string(),
  }),
});

export const collections = { changelog };
