import { Callout } from 'fumadocs-ui/components/callout';
import { bookCallUrl, contactEmail } from '@/lib/shared';

const mailto = `mailto:${contactEmail}?subject=${encodeURIComponent(
  'VaaniEval closed beta access',
)}`;

/**
 * The single source of truth for the closed-beta access message. Used anywhere
 * the reader is about to hit a repository they cannot clone yet, so the 404 is
 * explained before they see it rather than after.
 */
export function BetaAccess({ compact = false }: { compact?: boolean }) {
  return (
    <Callout type="info" title="VaaniEval is in closed beta">
      <p>
        The repositories below are <strong>private</strong> while the product is
        in closed beta, so the links will 404 unless your GitHub account has
        been granted access. Neither SDK is published to a public package
        registry yet — both install from Git.
      </p>
      <p>
        To get access, email{' '}
        <a href={mailto}>
          <strong>{contactEmail}</strong>
        </a>{' '}
        or{' '}
        <a href={bookCallUrl} target="_blank" rel="noreferrer">
          <strong>book a call</strong>
        </a>
        {compact ? '.' : (
          <>
            {' '}
            — a short conversation about your use case tells us whether
            VaaniEval fits, and gets you onboarded with the setup that matches
            your stack.
          </>
        )}
      </p>
    </Callout>
  );
}
