import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight, AudioLines, GitCompare, Timer } from 'lucide-react';
import { bookCallUrl, demoUrl } from '@/lib/shared';

const features = [
  {
    icon: Timer,
    title: 'Find the slow turn, not the slow service',
    body: 'A call is a chain of turns. VaaniEval times each one end to end — listening, thinking, speaking — and attributes the wait to the STT, LLM, tool or TTS span that actually caused it, including retried HTTP attempts hidden inside one framework call.',
  },
  {
    icon: AudioLines,
    title: 'Hear what the caller heard',
    body: 'Every call is stored as timeline-aligned stereo PCM with the agent on the left and the caller on the right, plus a transcript that follows playback. When a metric looks wrong, you play the exact second it describes.',
  },
  {
    icon: GitCompare,
    title: 'Check the transcript, not just the timing',
    body: 'Replay a recorded call against a stronger challenger model, see every word your production STT disagreed on, and have a judge flag only the disagreements that could have changed the conversation.',
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 pt-16 pb-12 text-center sm:pt-24">
        <Link
          href={demoUrl}
          target="_blank"
          rel="noreferrer"
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
        >
          <span className="size-1.5 rounded-full bg-fd-primary" />
          Explore 30 real calls in the live demo
          <ArrowRight className="size-3.5" />
        </Link>

        <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Observability and evaluation for voice agents
        </h1>

        <p className="mt-5 max-w-2xl text-lg text-fd-muted-foreground text-balance">
          Voice agents fail in ways a normal APM cannot see: the caller waited nine
          seconds, the transcription dropped a word that changed the booking, the
          model was retried twice inside one turn. VaaniEval records the whole
          call — audio, transcripts, provider spans and turn timings — and gives
          you the one turn that explains the complaint.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="inline-flex h-11 items-center rounded-lg bg-fd-primary px-5 font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Read the docs
          </Link>
          <Link
            href="/docs/quickstart/python"
            className="inline-flex h-11 items-center rounded-lg border border-fd-border px-5 font-medium transition-colors hover:bg-fd-accent"
          >
            Quickstart
          </Link>
          <Link
            href={demoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center rounded-lg border border-fd-border px-5 font-medium transition-colors hover:bg-fd-accent"
          >
            Live demo
          </Link>
        </div>

        <p className="mt-4 text-sm text-fd-muted-foreground">
          Python and Node.js SDKs · self-hosted dashboard · your audio never
          leaves your infrastructure
        </p>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-16">
        <div className="overflow-hidden rounded-xl border border-fd-border bg-fd-card shadow-sm">
          <Image
            src="/screenshots/call-detail.png"
            alt="A recorded VaaniEval call: the calls rail, the call waveform with turn markers, the transcript panel, and a trace listing every turn with its listening, thinking and speaking time."
            width={2880}
            height={1800}
            priority
            className="w-full"
          />
        </div>
        <p className="mt-3 text-center text-sm text-fd-muted-foreground">
          One recorded call in the console — four turns, two failures, and the
          24.2&nbsp;second wait that caused the complaint.
        </p>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-20">
        <div className="grid gap-6 sm:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-fd-border bg-fd-card p-6"
            >
              <feature.icon className="mb-4 size-5 text-fd-primary" />
              <h2 className="mb-2 font-semibold">{feature.title}</h2>
              <p className="text-sm text-fd-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-24">
        <div className="flex flex-col items-center gap-4 rounded-xl border border-fd-border bg-fd-card px-6 py-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Ten minutes to your first recorded call
          </h2>
          <p className="max-w-xl text-fd-muted-foreground">
            Install the SDK, point it at a locally running dashboard, and open the
            call you just made. No provider lock-in, no agent framework required.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            <Link
              href="/docs/quickstart/python"
              className="inline-flex h-10 items-center rounded-lg bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Python quickstart
            </Link>
            <Link
              href="/docs/quickstart/nodejs"
              className="inline-flex h-10 items-center rounded-lg border border-fd-border px-4 text-sm font-medium transition-colors hover:bg-fd-accent"
            >
              Node.js quickstart
            </Link>
            <Link
              href={bookCallUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center rounded-lg border border-fd-border px-4 text-sm font-medium transition-colors hover:bg-fd-accent"
            >
              Book a walkthrough
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
