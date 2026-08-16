import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export const revalidate = false;

function url(path: string): string {
  return new URL(path, siteUrl).toString();
}

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const pages = source.getPages().map((page) => ({
    url: url(page.url),
    lastModified: now,
    changeFrequency: 'weekly' as const,
    // The docs root outranks individual pages; quickstarts outrank deep reference.
    priority: page.url === '/docs' ? 0.9 : page.slugs[0] === 'quickstart' ? 0.8 : 0.7,
  }));

  return [
    {
      url: url('/'),
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...pages,
  ];
}
