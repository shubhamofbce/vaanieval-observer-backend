'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTheme } from 'next-themes';

/**
 * Renders a Mermaid diagram on the client. Mermaid is imported lazily so pages
 * without a diagram never pay for it, and the diagram is re-rendered on theme
 * change because Mermaid bakes colours into the generated SVG.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '');
  const container = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'inherit',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
        themeVariables:
          resolvedTheme === 'dark'
            ? { primaryColor: '#12241f', primaryBorderColor: '#3f8f77', lineColor: '#7b8794' }
            : { primaryColor: '#eefaf5', primaryBorderColor: '#3f8f77', lineColor: '#6b7280' },
      });

      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, chart.trim());
        if (!cancelled) setSvg(svg);
      } catch {
        if (!cancelled) setSvg('');
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [chart, id, resolvedTheme]);

  if (!svg) {
    return (
      <div
        ref={container}
        className="my-6 min-h-24 rounded-lg border border-fd-border bg-fd-card"
        aria-hidden
      />
    );
  }

  return (
    <div
      className="my-6 flex justify-center overflow-x-auto rounded-lg border border-fd-border bg-fd-card p-4 [&_svg]:max-w-full"
      // Mermaid output is generated from a literal string in our own MDX, and
      // Mermaid runs with securityLevel 'strict'.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
