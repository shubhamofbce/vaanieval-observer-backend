import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, demoUrl, repos } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
          <svg
            width="22"
            height="22"
            viewBox="0 0 32 32"
            aria-hidden
            className="shrink-0"
          >
            <rect width="32" height="32" rx="8" fill="#0d1526" />
            <g fill="#59d3ab">
              <rect x="6" y="13" width="3" height="6" rx="1.5" />
              <rect x="12" y="8" width="3" height="16" rx="1.5" />
              <rect x="18" y="11" width="3" height="10" rx="1.5" />
              <rect x="24" y="14" width="3" height="4" rx="1.5" />
            </g>
          </svg>
          {appName}
        </span>
      ),
    },
    links: [
      { text: 'Documentation', url: '/docs', active: 'nested-url' },
      { text: 'Live demo', url: demoUrl, external: true },
    ],
    githubUrl: repos.dashboard,
  };
}
