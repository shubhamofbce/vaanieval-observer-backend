# VaaniEval documentation site

The source for the VaaniEval developer documentation. Built with
[Fumadocs](https://fumadocs.dev) on Next.js 16, deployed to Vercel.

Content is MDX under `content/docs/`, and it is version-controlled in this
repository alongside the code it documents — so an API change and its
documentation move together in one commit.

## Develop

```bash
npm install
npm run dev
```

`http://localhost:3000`

## Build

```bash
npm run build
```

The build is the test. It type-checks, compiles every MDX file, and pre-renders
all pages, so a broken component reference or malformed MDX fails here.

## Deploy

Pushing to `main` deploys to <https://docs.vaanieval.com>. The Vercel project
`vaanieval-docs` is connected to this repository with **root directory `docs`**,
which is the setting the whole thing hangs on: this repo's root is the backend,
so a project rooted at `.` finds no `package.json` and the build fails.

A failed build is safe — Vercel leaves the previous production deployment
serving — so a broken `main` takes the docs stale rather than down. That is also
why `npm run build` passing locally is the gate before pushing.

There is no need to run `vercel deploy` by hand. Doing so still works, but a
CLI deploy uploads the local working tree, so it can publish content that is not
in `main` and leave the site silently ahead of (or behind) the repository.

## Layout

| Path | Contents |
| --- | --- |
| `content/docs/` | All documentation pages, as MDX |
| `content/docs/**/meta.json` | Sidebar ordering, titles and icons |
| `lib/shared.ts` | App name, demo/marketing/booking URLs, repository links |
| `lib/layout.shared.tsx` | Nav bar and logo |
| `components/mdx.tsx` | Globally available MDX components |
| `components/mermaid.tsx` | Mermaid diagram renderer |
| `app/(home)/page.tsx` | Landing page |
| `public/screenshots/` | Product screenshots captured from the live demo |

## Writing a page

1. Add an `.mdx` file under `content/docs/<section>/`.
2. Add its slug to that section's `meta.json` — **a page not listed there will
   not appear in the sidebar.**
3. Run `npm run build`.

Front matter is `title` and `description`. Both are used for SEO and the
generated OG image, so write the description as a real sentence.

### Available components

`Callout`, `Tabs`/`Tab`, `Steps`/`Step`, `Cards`/`Card`, `Accordions`/`Accordion`,
`Files`/`Folder`/`File`, `TypeTable`, `Mermaid` and `BetaAccess` are registered
globally in `components/mdx.tsx` — no imports needed in MDX.

Diagrams use the component, not a fenced block:

```mdx
<Mermaid chart={`
flowchart LR
  A --> B
`} />
```

Images in `public/` are given intrinsic dimensions automatically and are
click-to-zoom. Always write descriptive alt text — the screenshots carry real
information and the alt text is the only way a screen reader gets it.

## Conventions

These are load-bearing. The product is careful about what it claims, and the
documentation has to match:

- **Never document an API that does not exist in the source.** Verify against
  `app/`, `python-sdk/src/`, or `nodejs-sdk/src/` before writing.
- **Install instructions point at the private GitHub repositories.** Neither SDK
  is published to a public registry; do not add PyPI or npm-registry commands.
- **Say why the repository is private, wherever the reader is about to hit it.**
  Use `<BetaAccess />` (or `<BetaAccess compact />` where the page is already
  callout-heavy) rather than writing the closed-beta message by hand. It is the
  single source of truth for the access email and the booking link, both of
  which live in `lib/shared.ts`.
- **State limitations where they are relevant**, not in a footnote. The
  self-hosted dashboard has no authentication, no retention policy and no tenant
  isolation, and readers must not be able to miss that.
- **Unavailable is not zero.** When documenting a metric, say what it is derived
  from and when it is reported as unavailable.

## Deploy

Deployed on Vercel with this directory as the project root.

```bash
npx vercel --prod
```

Set `NEXT_PUBLIC_SITE_URL` to the canonical origin so metadata, OG images and
`llms.txt` use absolute URLs.

## Screenshots

Captured at 1440×900 from [demo.vaanieval.com](https://demo.vaanieval.com) and
resized to a maximum of 2200px. When the console UI changes materially, recapture
them — a stale screenshot is worse than none, because readers trust it.
