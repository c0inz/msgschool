import Link from "next/link";

export const metadata = {
  title: "Security — MsgSchool",
};

export default function SecurityPage() {
  return (
    <main className="min-h-screen">
      <header className="border-b border-black/90">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="font-semibold tracking-tight">
            ✦ MsgSchool
          </Link>
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/security" className="hover:underline">Security</Link>
            <Link href="/privacy" className="hover:underline">Privacy</Link>
            <Link href="/terms" className="hover:underline">Terms</Link>
          </nav>
        </div>
      </header>

      <article className="mx-auto max-w-3xl px-6 py-16">
        <p className="phase-number">■ SECURITY</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight">How we keep your credentials safe</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Last updated: May 1, 2026</p>

        <section className="prose mt-10 space-y-6 text-[var(--foreground)]">
          <p>
            MsgSchool reads your kid&apos;s Canvas and Skyward data on your behalf. To do that
            you give us a Canvas API token and (optionally) a Skyward username and password.
            This page tells you, plainly, what happens to those values inside our system — and
            equally importantly, what we cannot defend against.
          </p>

          <p>
            We try to be straight about both.
          </p>

          <h2 className="text-2xl font-semibold">Your sequestered per-user workspace</h2>
          <p>
            When you register, we provision a dedicated workspace for you on our server at a
            unique filesystem path keyed to your Telegram numeric ID. That workspace is{" "}
            <strong>yours alone</strong>. No other user&apos;s agent can read it. The encrypted
            credential ciphertexts, the agent&apos;s memory notes, the conversation context,
            and the data fetched on your behalf all live inside that one path and nowhere else.
            When you <code className="font-mono text-sm">/delete</code>, we remove that
            workspace in its entirety — there are no shared tables of credentials, no shared
            cache of grades, no other path your data has flowed to.
          </p>
          <p>
            The AI agent that talks to you is also yours alone. It has its own memory, its
            own loaded persona, its own session, its own cached context. It is not a shared
            chatbot that pretends to be different things to different people — it is{" "}
            <strong>your agent</strong>, instantiated once for you, with no view onto any
            other user&apos;s data, and no way to be addressed by anyone but you. Two
            different parents asking it the same question do not get answers from the same
            running process; each conversation is its own isolated instance.
          </p>

          <h2 className="text-2xl font-semibold">The threat we worry about most</h2>
          <p>
            The credential we treat as highest-risk is your <strong>Skyward password</strong>.
            A Canvas API token is recoverable — you go into Canvas settings, revoke it, and
            issue a new one in 30 seconds. A Skyward password, on the other hand, is the actual
            login. If a bad actor gets it, they can log in as you, change the password, view
            your home address, emergency contacts, sometimes the last 4 of an SSN, and in some
            districts they can update transportation routing for your kid. Account takeover is
            the worst case. Everything below is designed around that fear first.
          </p>

          <h2 className="text-2xl font-semibold">Where your credentials live</h2>
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong>On disk:</strong> only as ciphertext, encrypted with a key bound to our
              server&apos;s hardware (Linux{" "}
              <code className="font-mono text-sm">systemd-creds</code> machine-bound key). A
              disk image stolen while the server is powered off contains only ciphertext — the
              key is not on the disk, it is held by the operating system kernel. We have no way
              to decrypt those files on any other machine.
            </li>
            <li>
              <strong>In memory:</strong> only inside our <em>tool daemon</em>{" "}
              (<code className="font-mono text-sm">msgschool-toolsd</code>) — a separate
              long-running process whose only job is to call Canvas and Skyward on your behalf.
              The decrypted plaintext is evicted from this process&apos;s memory after at most
              10 minutes.
            </li>
            <li>
              <strong>In your AI agent:</strong> never. This is the design point we want you
              to take away from this page. The agent that talks to you in Telegram does not
              have the credential file in its filesystem, does not receive the credential as a
              tool input, and does not see the credential value in any form. It calls a tool
              like <code className="font-mono text-sm">canvas.get_pulse</code> and receives
              data — your kid&apos;s grades, missing assignments, attendance — but never the
              token or password that fetched them.
            </li>
            <li>
              <strong>In our chat logs:</strong> never. When you paste a credential into the
              bot, it is replaced with{" "}
              <code className="font-mono text-sm">[scrubbed: canvas.token]</code> in our
              database within milliseconds, and the original message is deleted from your
              Telegram chat about a second later.
            </li>
            <li>
              <strong>In our backups:</strong> only as ciphertext. Each nightly backup is
              encrypted with an{" "}
              <a
                href="https://age-encryption.org"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                age
              </a>{" "}
              recipient before it leaves the VM. We are in the process of moving the matching
              private key to fully offline storage; until that lands, the key is held in our
              operator credentials store on a separate host. See{" "}
              <em>Security work in progress</em> below.
            </li>
          </ul>

          <h2 className="text-2xl font-semibold">The four defense layers, in the order they fire</h2>
          <p>
            We don&apos;t rely on a single defense. Each of these runs even if the others
            failed:
          </p>
          <ol className="list-inside list-decimal space-y-3">
            <li>
              <strong>Inbound scrubber.</strong> The instant a credential-shaped message arrives
              from Telegram, we redact it in our database and call Telegram&apos;s delete API
              to remove the original message from your chat history. This fires whether or not
              we can identify which service the credential is for — credential-shaped, but
              unclassifiable, still gets deleted.
            </li>
            <li>
              <strong>Behavioral rules on the AI agent.</strong> The agent&apos;s standing
              instructions explicitly forbid: reading the credential file, writing any script
              that contains a credential value, calling Canvas or Skyward directly, and
              echoing a credential into chat. The agent calls our tool daemon for every read.
              This is the layer that prevents the most common LLM-leak failure mode (a model
              helpfully &quot;showing its work&quot; with the actual values).
            </li>
            <li>
              <strong>Outbound scrubber.</strong> Every reply the agent composes runs through
              a filter that strips literal occurrences of your known credential bytes before
              the message reaches you. If the agent ever <em>did</em> try to echo your
              password, the filter catches it and you see{" "}
              <code className="font-mono text-sm">[redacted]</code> instead of the value.
            </li>
            <li>
              <strong>Periodic at-rest sweep.</strong> Every two minutes, a background scanner
              reads your in-memory credential bytes and greps every file in your agent&apos;s
              workspace for any plaintext occurrence. Anything found is replaced in place
              with <code className="font-mono text-sm">[redacted-credscan]</code>. This catches
              anything that sneaks past the first three layers and would otherwise sit on disk
              and end up in a backup.
            </li>
          </ol>

          <h2 className="text-2xl font-semibold">What we cannot defend against</h2>
          <p>
            We&apos;d rather tell you these up front than have you discover them later.
          </p>
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong>Compromise of our server itself.</strong> If an attacker gets root on
              our VM, they can read the in-memory credentials of the running tool daemon. No
              app-level mitigation prevents that — our defense is keeping the server hardened,
              patched, and not reachable from the public internet except through the Telegram
              webhook.
            </li>
            <li>
              <strong>Compromise of Telegram itself, your Telegram account, or your phone.</strong>{" "}
              The bot reaches you through Telegram. We can&apos;t protect a chat session that
              an attacker has already taken over from the device side.
            </li>
            <li>
              <strong>Telegram&apos;s own retention of deleted messages.</strong> When we
              delete your credential paste from your chat, Telegram tells both ends the
              message is gone. Telegram&apos;s internal retention policy for deleted messages
              is not something we control or can verify.
            </li>
            <li>
              <strong>Misuse of credentials by us.</strong> We use them to read your data and
              for nothing else, but you are trusting us on that. If that trust is a problem
              for your situation, MsgSchool is not the right tool for you.
            </li>
          </ul>

          <h2 className="text-2xl font-semibold">If something happens, here&apos;s what to do</h2>
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong>Rotate the Canvas token:</strong> Canvas → Account → Settings → Approved
              Integrations → delete the MsgSchool token. Issue a new one and re-paste it to
              the bot. The old token is dead within seconds.
            </li>
            <li>
              <strong>Change the Skyward password:</strong> log into Skyward Family Access
              and change your password. Re-send the new value to the bot. (Note: Skyward
              session cookies often survive a password change for some hours; if you suspect
              an active session, contact your district IT to force a logout.)
            </li>
            <li>
              <strong>Wipe everything we have on you:</strong> DM the bot{" "}
              <code className="font-mono text-sm">/delete</code>, then reply{" "}
              <code className="font-mono text-sm">Delete</code> to confirm. We delete your
              account record, all conversation history, the agent&apos;s memory, and the
              encrypted credential files. The encrypted backup tarball is purged after
              30 days.
            </li>
          </ul>

          <h2 className="text-2xl font-semibold">Security work in progress</h2>
          <p>
            We&apos;re a small operation and continue to harden the platform. The two items
            currently in flight:
          </p>
          <ul className="list-inside list-disc space-y-2">
            <li>
              <strong>Per-user OS-level isolation</strong> between the AI agent and the
              credential daemon. Today the protection that keeps the agent from reading the
              credential file is behavioral — playbooks, the four defense layers above, and
              process discipline. The structural version runs the agent under a separate
              operating-system user account that <em>cannot</em> read the daemon&apos;s files
              even if the agent code asked it to. That change is in design and waiting on a
              dependency in our underlying agent runtime.
            </li>
            <li>
              <strong>Off-site encrypted backups with an offline decryption key.</strong>{" "}
              Today backups are at-rest encrypted on the same VM. We&apos;re moving the
              backup target off-VM with a key held offline so that even total compromise of
              the live host doesn&apos;t expose historical state.
            </li>
          </ul>
          <p>
            We&apos;ll update this page when each one ships.
          </p>

          <h2 className="text-2xl font-semibold">Found something?</h2>
          <p>
            If you think you&apos;ve found a security issue with MsgSchool, please email{" "}
            <a href="mailto:security@msgschool.com" className="underline">
              security@msgschool.com
            </a>{" "}
            with what you saw, what you tried, and how to reproduce it. We answer within
            24 hours.
          </p>
        </section>

        <p className="mt-12 text-sm text-[var(--muted)]">
          ← <Link href="/" className="underline">back to MsgSchool</Link>
        </p>
      </article>

      <footer className="border-t border-black/90 py-10 text-center text-sm text-[var(--muted)]">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
            <div>✦ MsgSchool · © {new Date().getFullYear()}</div>
            <div className="flex gap-6">
              <Link href="/security" className="hover:underline">Security</Link>
              <Link href="/privacy" className="hover:underline">Privacy</Link>
              <Link href="/terms" className="hover:underline">Terms</Link>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
