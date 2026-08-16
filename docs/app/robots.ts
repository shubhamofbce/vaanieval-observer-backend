import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/shared';

export const revalidate = false;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Per-page OG images and the search index are crawl budget with no search value.
        disallow: ['/api/', '/og/'],
      },
    ],
    sitemap: new URL('/sitemap.xml', siteUrl).toString(),
    host: siteUrl,
  };
}
