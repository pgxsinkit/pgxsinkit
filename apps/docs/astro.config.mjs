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
const [pgwasmTypeDoc, pgwasmTypeDocSidebar] = createStarlightTypeDocPlugin();
const [pgwasmCTypeDoc, pgwasmCTypeDocSidebar] = createStarlightTypeDocPlugin();
const [pgwasmPgDumpTypeDoc, pgwasmPgDumpTypeDocSidebar] = createStarlightTypeDocPlugin();
const [pgwasmReplTypeDoc, pgwasmReplTypeDocSidebar] = createStarlightTypeDocPlugin();

export default defineConfig({
  site: "https://pgxsinkit.github.io",
  integrations: [
    starlight({
      title: "pgxsinkit",
      description:
        "An offline-first sync toolkit for PostgreSQL/Supabase, ElectricSQL's Circuits engine, Drizzle, and pgwasm (Postgres in the browser).",
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
            "pgxsinkit is an offline-first sync toolkit for the PostgreSQL -> Circuits engine -> durable-streams -> pgwasm read path and the client -> write API -> PostgreSQL write path. Subscriptions are granted by a control plane and every read is gated at a stream edge. The @pgxsinkit/* packages are the product; a demo board app and an integration + performance harness prove and harden them. It targets engineers building local-first apps on Postgres/Supabase with Drizzle, ElectricSQL's Circuits engine, and pgwasm, the toolkit's own Postgres-in-WebAssembly runtime (which began as PGlite).",
        }),
        contractsTypeDoc({
          entryPoints: ["../../packages/contracts/src/index.ts"],
          tsconfig: "../../packages/contracts/tsconfig.typedoc.json",
          output: "api/contracts",
          typeDoc: { gitRemote: "upstream", excludeInternal: true },
          sidebar: { label: "@pgxsinkit/contracts", collapsed: true },
        }),
        clientTypeDoc({
          entryPoints: ["../../packages/client/src/index.ts"],
          tsconfig: "../../packages/client/tsconfig.typedoc.json",
          output: "api/client",
          typeDoc: { gitRemote: "upstream", excludeInternal: true },
          sidebar: { label: "@pgxsinkit/client", collapsed: true },
        }),
        serverTypeDoc({
          entryPoints: ["../../packages/server/src/index.ts"],
          tsconfig: "../../packages/server/tsconfig.typedoc.json",
          output: "api/server",
          typeDoc: { gitRemote: "upstream", excludeInternal: true },
          sidebar: { label: "@pgxsinkit/server", collapsed: true },
        }),
        reactTypeDoc({
          entryPoints: ["../../packages/react/src/index.ts"],
          tsconfig: "../../packages/react/tsconfig.typedoc.json",
          output: "api/react",
          typeDoc: { gitRemote: "upstream", excludeInternal: true },
          sidebar: { label: "@pgxsinkit/react", collapsed: true },
        }),
        pgwasmTypeDoc({
          entryPoints: [
            "../../packages/pgwasm/src/index.ts",
            "../../packages/pgwasm/src/build/index.ts",
            "../../packages/pgwasm/src/drizzle/index.ts",
            "../../packages/pgwasm/src/fs/index.ts",
            "../../packages/pgwasm/src/live/index.ts",
            "../../packages/pgwasm/src/opfs/index.ts",
            "../../packages/pgwasm/src/protocol/index.ts",
          ],
          tsconfig: "../../packages/pgwasm/tsconfig.typedoc.json",
          output: "api/pgwasm",
          typeDoc: { gitRemote: "upstream", excludeInternal: true },
          sidebar: { label: "@pgxsinkit/pgwasm", collapsed: true },
        }),
        pgwasmCTypeDoc({
          entryPoints: [
            "../../packages/pgwasm-c/src/index.ts",
            "../../packages/pgwasm-c/src/prepopulated.ts",
            "../../packages/pgwasm-c/src/contrib/amcheck.ts",
          ],
          tsconfig: "../../packages/pgwasm-c/tsconfig.typedoc.json",
          output: "api/pgwasm-c",
          typeDoc: { gitRemote: "upstream", excludeInternal: true },
          sidebar: { label: "@pgxsinkit/pgwasm-c", collapsed: true },
        }),
        pgwasmPgDumpTypeDoc({
          entryPoints: ["../../packages/pgwasm-pg-dump/src/index.ts"],
          tsconfig: "../../packages/pgwasm-pg-dump/tsconfig.typedoc.json",
          output: "api/pgwasm-pg-dump",
          typeDoc: { gitRemote: "upstream", excludeInternal: true },
          sidebar: { label: "@pgxsinkit/pgwasm-pg-dump", collapsed: true },
        }),
        pgwasmReplTypeDoc({
          entryPoints: ["../../packages/pgwasm-repl/src/index.ts"],
          tsconfig: "../../packages/pgwasm-repl/tsconfig.typedoc.json",
          output: "api/pgwasm-repl",
          typeDoc: { gitRemote: "upstream", excludeInternal: true },
          sidebar: { label: "@pgxsinkit/pgwasm-repl", collapsed: true },
        }),
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What is pgxsinkit?", slug: "start/overview" },
            { label: "Getting started", slug: "start/getting-started" },
            { label: "Deploying the server", slug: "start/deploying-the-server" },
            { label: "Operating in production", slug: "start/operating-in-production" },
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
            pgwasmTypeDocSidebar,
            pgwasmCTypeDocSidebar,
            pgwasmPgDumpTypeDocSidebar,
            pgwasmReplTypeDocSidebar,
          ],
        },
        { label: "Design decisions", items: [{ autogenerate: { directory: "decisions" } }] },
        { label: "Project", items: [{ autogenerate: { directory: "project" } }] },
      ],
    }),
  ],
});
