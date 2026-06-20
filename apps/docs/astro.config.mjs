// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import { createStarlightTypeDocPlugin } from "starlight-typedoc";

const ogImage = "https://pgxsinkit.github.io/og.png";

const [contractsTypeDoc, contractsTypeDocSidebar] = createStarlightTypeDocPlugin();
const [clientTypeDoc, clientTypeDocSidebar] = createStarlightTypeDocPlugin();
const [serverTypeDoc, serverTypeDocSidebar] = createStarlightTypeDocPlugin();
const [reactTypeDoc, reactTypeDocSidebar] = createStarlightTypeDocPlugin();

export default defineConfig({
  site: "https://pgxsinkit.github.io",
  integrations: [
    starlight({
      title: "pgxsinkit",
      description: "An offline-first sync toolkit for PostgreSQL/Supabase, ElectricSQL, Drizzle, and PGlite.",
      logo: {
        light: "./src/assets/pgxsinkit-wordmark.svg",
        dark: "./src/assets/pgxsinkit-wordmark-dark.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      customCss: ["@fontsource/jetbrains-mono/400.css", "@fontsource/jetbrains-mono/600.css", "./src/styles/brand.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/pgxsinkit/pgxsinkit" }],
      head: [
        { tag: "meta", attrs: { property: "og:image", content: ogImage } },
        { tag: "meta", attrs: { name: "twitter:card", content: "summary_large_image" } },
        { tag: "meta", attrs: { name: "twitter:image", content: ogImage } },
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "any" } },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: "pgxsinkit",
          description:
            "pgxsinkit is an offline-first sync toolkit for the PostgreSQL -> ElectricSQL -> PGlite read path and the client -> write API -> PostgreSQL write path. The @pgxsinkit/* packages are the product; a demo app and an integration + performance harness prove and harden them. It targets engineers building local-first apps on Postgres/Supabase with Drizzle, Electric, and PGlite.",
        }),
        contractsTypeDoc({
          entryPoints: ["../../packages/contracts/src/index.ts"],
          tsconfig: "../../packages/contracts/tsconfig.typedoc.json",
          output: "api/contracts",
          sidebar: { label: "@pgxsinkit/contracts", collapsed: true },
        }),
        clientTypeDoc({
          entryPoints: ["../../packages/client/src/index.ts"],
          tsconfig: "../../packages/client/tsconfig.typedoc.json",
          output: "api/client",
          sidebar: { label: "@pgxsinkit/client", collapsed: true },
        }),
        serverTypeDoc({
          entryPoints: ["../../packages/server/src/index.ts"],
          tsconfig: "../../packages/server/tsconfig.typedoc.json",
          output: "api/server",
          sidebar: { label: "@pgxsinkit/server", collapsed: true },
        }),
        reactTypeDoc({
          entryPoints: ["../../packages/react/src/index.ts"],
          tsconfig: "../../packages/react/tsconfig.typedoc.json",
          output: "api/react",
          sidebar: { label: "@pgxsinkit/react", collapsed: true },
        }),
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is pgxsinkit?", slug: "start/overview" },
            { label: "Getting started", slug: "start/getting-started" },
            { label: "Use these docs with your AI assistant", slug: "start/ai-assistants" },
          ],
        },
        { label: "Core concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Packages", items: [{ autogenerate: { directory: "packages" } }] },
        { label: "Demo & harness", items: [{ autogenerate: { directory: "demo-and-harness" } }] },
        {
          label: "API reference",
          items: [
            { label: "Overview", slug: "reference" },
            contractsTypeDocSidebar,
            clientTypeDocSidebar,
            serverTypeDocSidebar,
            reactTypeDocSidebar,
          ],
        },
        { label: "Design decisions", items: [{ autogenerate: { directory: "decisions" } }] },
        { label: "Project", items: [{ autogenerate: { directory: "project" } }] },
      ],
    }),
  ],
});
