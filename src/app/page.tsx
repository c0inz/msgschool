import Link from "next/link";

const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_HANDLE || "MsgSchoolBot";
const TG_URL = `https://t.me/${BOT}`;

export default function Home() {
  return (
    <main className="min-h-screen">
      {/* Top bar */}
      <header className="border-b border-black/90">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="font-semibold tracking-tight">
            ✦ MsgSchool
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="#how" className="hover:underline">
              How it works
            </Link>
            <Link href="/security" className="hover:underline">
              Security
            </Link>
            <Link href="/privacy" className="hover:underline">
              Privacy
            </Link>
            <Link href="/terms" className="hover:underline">
              Terms
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="dots-bg border-b border-black/90">
        <div className="mx-auto max-w-4xl px-6 py-24 text-center md:py-32">
          <p className="phase-number">■ 01 · OPEN TELEGRAM</p>
          <h1 className="mt-6 text-5xl font-bold tracking-tight md:text-7xl">
            Your Canvas &amp; Skyward
            <br />
            agent. 24/7.
          </h1>
          <p className="mt-6 text-lg text-[var(--muted)] md:text-xl">
            One message opens the door. No signup, no MsgSchool credentials, no browser tab.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a href={TG_URL} className="btn-primary" target="_blank" rel="noopener noreferrer">
              → Open Telegram and message @{BOT}
            </a>
          </div>

          <p className="mt-6 text-sm text-[var(--muted)]">
            Use code{" "}
            <span className="font-mono font-semibold text-[var(--foreground)]">FreeAgent2026</span>{" "}
            to register.
          </p>
        </div>
      </section>

      {/* Privacy stripe */}
      <section className="border-b border-black/90 bg-[var(--background)]">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="phase-number">▣ PRIVACY BY CONSTRUCTION</p>
              <p className="mt-3 text-lg font-semibold tracking-tight md:text-xl">
                Open source · Sequestered per-user workspace · Your school credentials never
                reach the AI · Defense-in-depth credential scrubbing
              </p>
            </div>
            <Link
              href="/security"
              className="shrink-0 border-2 border-black/90 px-5 py-2 text-sm font-semibold tracking-tight transition-transform hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[4px_4px_0_#0a0a0a]"
            >
              Read the architecture →
            </Link>
          </div>
        </div>
      </section>

      {/* How it works — three phases */}
      <section id="how" className="border-b border-black/90">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-12 md:grid-cols-3">
            <Phase n="01" label="HELLO">
              <h3 className="text-2xl font-bold">Say hi on Telegram.</h3>
              <p className="mt-3 text-[var(--muted)]">
                Open @{BOT} and send any message. The bot replies with what it does for you and how
                to unlock it.
              </p>
            </Phase>
            <Phase n="02" label="UNLOCK">
              <h3 className="text-2xl font-bold">Enter a code.</h3>
              <p className="mt-3 text-[var(--muted)]">
                Paste{" "}
                <span className="font-mono font-semibold text-[var(--foreground)]">
                  FreeAgent2026
                </span>{" "}
                in-chat. Your account is provisioned in seconds.
              </p>
            </Phase>
            <Phase n="03" label="USE">
              <h3 className="text-2xl font-bold">Ask it anything school.</h3>
              <p className="mt-3 text-[var(--muted)]">
                Your own agent watches Canvas and Skyward for you — assignments, grades, missing
                work, announcements. It messages you when something changes.
              </p>
            </Phase>
          </div>
        </div>
      </section>

      {/* Capabilities grid */}
      <section className="border-b border-black/90">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <p className="phase-number">★ WHAT IT DOES</p>
          <h2 className="mt-4 text-3xl font-bold tracking-tight md:text-4xl">
            Narrow on purpose. Deep on homework.
          </h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 md:grid-cols-3">
            {CAPABILITIES.map((c) => (
              <div
                key={c.title}
                className="border-2 border-black/90 p-6 transition-transform hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[4px_4px_0_#0a0a0a]"
              >
                <div className="font-mono text-xs tracking-widest text-[var(--muted)]">
                  {c.icon} {c.tag}
                </div>
                <div className="mt-3 font-semibold">{c.title}</div>
                <div className="mt-2 text-sm text-[var(--muted)]">{c.body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-b border-black/90">
        <div className="mx-auto max-w-4xl px-6 py-20 text-center">
          <p className="phase-number">⌘ READY?</p>
          <h2 className="mt-4 text-4xl font-bold tracking-tight md:text-5xl">
            One message and you&apos;re in.
          </h2>
          <div className="mt-8">
            <a href={TG_URL} className="btn-primary" target="_blank" rel="noopener noreferrer">
              → Message @{BOT}
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 text-center text-sm text-[var(--muted)]">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
            <div>✦ MsgSchool · © {new Date().getFullYear()}</div>
            <div className="flex gap-6">
              <Link href="/security" className="hover:underline">
                Security
              </Link>
              <Link href="/privacy" className="hover:underline">
                Privacy
              </Link>
              <Link href="/terms" className="hover:underline">
                Terms
              </Link>
              <a href={TG_URL} className="hover:underline" target="_blank" rel="noopener noreferrer">
                @{BOT}
              </a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Phase({
  n,
  label,
  children,
}: {
  n: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t-2 border-black/90 pt-6">
      <div className="phase-number">
        {n} · {label}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

const CAPABILITIES: { icon: string; tag: string; title: string; body: string }[] = [
  {
    icon: "■",
    tag: "CANVAS",
    title: "Assignment radar",
    body: "New assignments, due dates, submission status — surfaced before they surprise you.",
  },
  {
    icon: "★",
    tag: "SKYWARD",
    title: "Grades + attendance",
    body: "Watches grade changes and attendance flags. Messages you when anything moves.",
  },
  {
    icon: "→",
    tag: "CONTEXT",
    title: "Ask about anything",
    body: "Your agent has your student context loaded. Ask questions in plain English, any time.",
  },
  {
    icon: "✦",
    tag: "NOTIFY",
    title: "Proactive pings",
    body: "Missing work, upcoming tests, announcements. Filtered for what actually matters.",
  },
  {
    icon: "⌘",
    tag: "PRIVATE",
    title: "Your own sandbox",
    body: "Each user gets their own isolated workspace. Your data never mixes with anyone else's.",
  },
  {
    icon: "✱",
    tag: "24/7",
    title: "Always on",
    body: "The agent runs continuously. No app to open — it reaches out on Telegram.",
  },
];
