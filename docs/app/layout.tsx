import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { siteUrl } from '@/lib/shared';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'VaaniEval — observability and evaluation for voice agents',
    template: '%s · VaaniEval docs',
  },
  description:
    'VaaniEval records every voice-agent call as a portable session package — audio, transcripts, provider spans and turn timings — then shows you exactly which turn was slow, which one failed, and what the caller heard.',
  openGraph: {
    siteName: 'VaaniEval docs',
    type: 'website',
    url: siteUrl,
  },
  alternates: {
    canonical: '/',
  },
  verification: {
    google: 'wU-cu5B8qycWQOCJlqzbXWztln7o8y7dFQOPgxWI-Wc',
    other: {
      'msvalidate.01': '2DD28DA0A845FDF28E1BBB50CB9487E5',
    },
  },
  twitter: { card: 'summary_large_image' },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
