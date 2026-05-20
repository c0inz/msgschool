import Link from "next/link";

export const metadata = {
  title: "Privacy — MsgSchool",
};

export default function PrivacyPage() {
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
        <p className="phase-number">■ PRIVACY</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Last updated: May 1, 2026</p>

        <section className="prose mt-10 space-y-6 text-[var(--foreground)]">
          <p>
            MsgSchool (&quot;we&quot;, &quot;our&quot;) is a narrow, Telegram-first assistant for
            tracking Canvas and Skyward. This policy explains what we collect, why, and what we do
            with it.
          </p>

          <h2 className="text-2xl font-semibold">What we collect</h2>
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong>Telegram identifiers.</strong> Your Telegram numeric user ID and username so
              we can route messages to your agent.
            </li>
            <li>
              <strong>Messages you send the bot.</strong> To respond, log, and audit for abuse.
            </li>
            <li>
              <strong>Credentials you provide.</strong> To watch your Canvas and Skyward accounts,
              you provide limited credentials — portal URLs, API tokens, and in some cases a
              school login username and password. They are stored encrypted at rest in an
              isolated per-user workspace using a machine-bound key held by our server&apos;s
              operating system kernel (Linux{" "}
              <code className="font-mono text-sm">systemd-creds</code>). The encrypted files and
              the key are stored separately; a disk image stolen while our server is powered off
              contains only ciphertext. Decryption happens in memory at the moment of use by the
              MsgSchool service — never written to disk in plaintext, never written to backups
              in plaintext. We use them solely to read your own Canvas and Skyward data on your
              behalf, never share them with third parties, and never use them for any other
              purpose.
            </li>
            <li>
              <strong>Activity the agent observes.</strong> Assignments, grades, attendance, and
              announcements pulled from the services you connect. Stored only inside your own
              isolated workspace.
            </li>
            <li>
              <strong>Operational logs.</strong> Webhook events, error traces, timing, and usage
              counters for debugging and capacity planning.
            </li>
          </ul>

          <h2 className="text-2xl font-semibold">What we do not collect</h2>
          <ul className="list-inside list-disc space-y-2">
            <li>You do not create a MsgSchool account, password, or email — Telegram is your identity.</li>
            <li>We do not sell any data to third parties.</li>
            <li>We do not use your data to train general-purpose AI models.</li>
          </ul>

          <h2 className="text-2xl font-semibold">How your data is isolated</h2>
          <p>
            Every user is assigned their own dedicated workspace on our server. Your messages,
            credentials, and observed activity live only in that workspace. Other users cannot
            see it, and neither can other agents on the platform. The server itself sits behind
            our own firewall and is not reachable from the public internet except through the
            Telegram webhook endpoint.
          </p>

          <h2 className="text-2xl font-semibold">Credential handling when you share them</h2>
          <p>
            When you paste a Canvas URL, API token, Skyward portal URL, username, or password
            into the bot, MsgSchool detects the credential-shaped message on arrival and does
            three things within about a second: (1) writes it encrypted to your workspace using
            the mechanism above, (2) deletes the original paste from your Telegram chat so it
            doesn&apos;t sit in your history, and (3) acknowledges with a short receipt like
            &ldquo;Stored canvas.token.&rdquo; The raw value is not logged, not echoed back to
            you, and not passed to the AI model.
          </p>

          <h2 className="text-2xl font-semibold">How your AI agent sees (and does not see) your credentials</h2>
          <p>
            Your Canvas API token and Skyward username and password are decrypted only inside
            an isolated tool daemon (<code className="font-mono text-sm">msgschool-toolsd</code>)
            that runs alongside the bot. Your AI agent never reads the credential file directly
            and never receives the credential value. When the agent needs your grades or
            attendance, it calls a high-level tool — for example{" "}
            <code className="font-mono text-sm">canvas.get_pulse</code> or{" "}
            <code className="font-mono text-sm">skyward.get_grades</code> — and receives the
            data, not the credential. The agent&apos;s standing instructions explicitly forbid
            reading credential files, writing scripts that contain credential values, and
            echoing credentials in chat. As a final defense-in-depth net, every reply the agent
            composes runs through an outbound filter that strips known credential bytes before
            the message reaches you, so even an unintended leak path is closed before it lands
            on your screen.
          </p>
          <p>
            For the full architecture — the four defense layers, what we explicitly cannot
            defend against, and what to do if you suspect a leak — see our{" "}
            <Link href="/security" className="underline">Security page</Link>.
          </p>

          <h2 className="text-2xl font-semibold">Security work in progress</h2>
          <p>
            MsgSchool is a small operation and we&apos;re continuing to improve its security
            posture. Two items are in flight: (1) encrypted off-site backups with an offline
            decryption key, and (2) running the AI agent under a separate operating-system
            user account so that it cannot read the credential daemon&apos;s files even if it
            wanted to (today the protection is behavioral; that change makes it structural).
            We will update this policy when each one lands.
          </p>

          <h2 className="text-2xl font-semibold">Data retention</h2>
          <p>
            We keep your data as long as your account is active. If you want your account and its
            data removed, email{" "}
            <a href="mailto:privacy@msgschool.com" className="underline">
              privacy@msgschool.com
            </a>{" "}
            and we will remove your workspace, credentials, message log, and any copies in our
            backup rotation. Backups are retained for up to 30 days and then pruned.
          </p>

          <h2 className="text-2xl font-semibold">Third-party services</h2>
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong>Telegram.</strong> Messages transit Telegram&apos;s servers. Their{" "}
              <a
                href="https://telegram.org/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                privacy policy
              </a>{" "}
              applies to their infrastructure.
            </li>
            <li>
              <strong>Canvas &amp; Skyward.</strong> We connect to your schools&apos; Canvas and
              Skyward instances using credentials you give us, read-only where possible.
            </li>
            <li>
              <strong>Language model providers.</strong> The agent runs on third-party large
              language models whose own terms govern the prompts and responses sent to them. We
              periodically change which providers we route to as the field evolves; the active
              set at any moment is small and operational. None of these providers receive your
              raw Canvas or Skyward credentials — the agent queries those services from our
              server and only sends the resulting data into model prompts. If you need to know
              the current provider for a specific compliance reason, email{" "}
              <a href="mailto:privacy@msgschool.com" className="underline">
                privacy@msgschool.com
              </a>{" "}
              and we&apos;ll tell you.
            </li>
          </ul>

          <h2 className="text-2xl font-semibold">Children</h2>
          <p>
            MsgSchool is intended for parents, guardians, and students age 13 and up. We do not
            knowingly collect data from users under 13. If you are a parent or guardian and
            believe your under-13 child has created an account, email{" "}
            <a href="mailto:privacy@msgschool.com" className="underline">
              privacy@msgschool.com
            </a>{" "}
            and we will delete the account and its associated data within seven days.
          </p>

          <h2 className="text-2xl font-semibold">Contact</h2>
          <p>
            Questions:{" "}
            <a href="mailto:privacy@msgschool.com" className="underline">
              privacy@msgschool.com
            </a>
          </p>
        </section>
      </article>

      <footer className="border-t border-black/90 py-8 text-center text-sm text-[var(--muted)]">
        ✦ MsgSchool · <Link href="/security" className="underline">Security</Link> · <Link href="/terms" className="underline">Terms</Link>
      </footer>
    </main>
  );
}
