import Link from "next/link";

export const metadata = {
  title: "Terms — MsgSchool",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen">
      <header className="border-b border-black/90">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="font-semibold tracking-tight">
            ✦ MsgSchool
          </Link>
          <nav className="flex items-center gap-6 text-sm">
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

      <article className="mx-auto max-w-3xl px-6 py-16">
        <p className="phase-number">★ TERMS</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Last updated: April 21, 2026</p>

        <section className="prose mt-10 space-y-6 text-[var(--foreground)]">
          <p>
            By messaging the MsgSchool bot on Telegram or using this website, you agree to these
            terms. If you don&apos;t agree, don&apos;t use the service.
          </p>

          <h2 className="text-2xl font-semibold">1. What MsgSchool is</h2>
          <p>
            MsgSchool is a narrow, Telegram-first assistant. It connects to your Canvas and Skyward
            accounts and sends you updates about assignments, grades, attendance, and
            announcements. It&apos;s designed to be helpful, not exhaustive. It is not a substitute
            for your school&apos;s official communication channels.
          </p>

          <h2 className="text-2xl font-semibold">2. Accounts and access</h2>
          <ul className="list-inside list-disc space-y-2">
            <li>
              Your Telegram account is your identity. You are responsible for keeping it secure.
            </li>
            <li>
              You must have the right to connect any Canvas or Skyward credentials you provide. Do
              not connect accounts that aren&apos;t yours or a minor child&apos;s that you are
              guardian of.
            </li>
            <li>
              MsgSchool is intended for parents, guardians, and students age 13 and up.
            </li>
          </ul>

          <h2 className="text-2xl font-semibold">3. Access</h2>
          <ul className="list-inside list-disc space-y-2">
            <li>
              Access is unlocked with a valid registration code (such as{" "}
              <span className="font-mono">FreeAgent2026</span>).
            </li>
            <li>
              Access lasts 30 days from activation and may be extended or ended without notice as
              the product is refined.
            </li>
            <li>
              <strong>Usage limits.</strong> Free access includes a rate limit: up to 15 messages
              per rolling 24 hours and 60 messages per rolling 30 days. If you hit a limit, the
              bot will tell you and point you to{" "}
              <a
                href="https://t.me/johntdavenport"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                @johntdavenport
              </a>{" "}
              on Telegram to discuss higher limits. Certain platform commands
              (<code className="font-mono">/help</code>,{" "}
              <code className="font-mono">/commands</code>,{" "}
              <code className="font-mono">/status</code>,{" "}
              <code className="font-mono">/reset</code>) don&apos;t count toward the cap.
            </li>
          </ul>

          <h2 className="text-2xl font-semibold">4. Acceptable use</h2>
          <p>Don&apos;t:</p>
          <ul className="list-inside list-disc space-y-2">
            <li>Use MsgSchool to impersonate a student or parent you aren&apos;t.</li>
            <li>Use MsgSchool to cheat — submit work, complete assessments, or bypass exams.</li>
            <li>
              Attempt to extract other users&apos; data, probe the sandboxing, or overload the
              service.
            </li>
            <li>Use MsgSchool to harass, threaten, or surveil others.</li>
          </ul>
          <p>
            We can suspend or terminate access at any time for any use that violates these terms.
          </p>

          <h2 className="text-2xl font-semibold">5. The agent and its limits</h2>
          <p>
            MsgSchool uses third-party large language models to compose the agent&apos;s replies;
            the active set can change over time and our{" "}
            <Link href="/privacy" className="underline">Privacy Policy</Link>{" "}
            describes how that data is handled. Regardless of which model answers, the agent is
            helpful but not perfect — it can misread data, make mistakes, or miss updates. Treat
            its output as a convenience, not as authoritative. Check official Canvas and Skyward
            sources for anything that matters.
          </p>

          <h2 className="text-2xl font-semibold">6. Data</h2>
          <p>
            Our{" "}
            <Link href="/privacy" className="underline">
              Privacy Policy
            </Link>{" "}
            describes what we collect, how we store it, and how to delete it.
          </p>

          <h2 className="text-2xl font-semibold">7. Warranty and liability</h2>
          <p>
            MsgSchool is provided &quot;as is&quot; without warranties. To the extent permitted by
            law, MsgSchool and its operators are not liable for indirect, incidental, or
            consequential damages arising from your use of the service. Total liability is limited
            to the amount you paid MsgSchool in the twelve months preceding a claim.
          </p>

          <h2 className="text-2xl font-semibold">8. Changes</h2>
          <p>
            We may update these terms. When we do, we&apos;ll update the date at the top and, for
            material changes, notify you via the bot. Continued use constitutes acceptance.
          </p>

          <h2 className="text-2xl font-semibold">9. Contact</h2>
          <p>
            <a href="mailto:support@msgschool.com" className="underline">
              support@msgschool.com
            </a>
          </p>
        </section>
      </article>

      <footer className="border-t border-black/90 py-8 text-center text-sm text-[var(--muted)]">
        ✦ MsgSchool · <Link href="/security" className="underline">Security</Link> · <Link href="/privacy" className="underline">Privacy</Link>
      </footer>
    </main>
  );
}
