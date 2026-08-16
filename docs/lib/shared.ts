export const appName = 'VaaniEval';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://docs.vaanieval.com';
export const demoUrl = 'https://demo.vaanieval.com';
export const marketingUrl = 'https://www.vaanieval.com';
export const bookCallUrl = 'https://calendar.app.google/5cNH8hB13LoC39Qk7';
export const contactEmail = 'shubham@vaanieval.com';

/** The three private repositories that make up the platform. */
export const repos = {
  dashboard: 'https://github.com/shubhamofbce/vaanieval-observer-backend',
  python: 'https://github.com/shubhamofbce/vaanieval-observer-python-sdk',
  node: 'https://github.com/shubhamofbce/vaanieval-observer-nodejs-sdk',
};

export const gitConfig = {
  user: 'shubhamofbce',
  repo: 'vaanieval-observer-backend',
  branch: 'main',
  /** The docs site lives in a subdirectory of the backend repo. */
  contentPath: 'docs/content/docs',
};
