/**
 * All user-facing bot copy that originates from msgschool (not the agent).
 *
 * Once a user is `active`, msgschool NEVER speaks in its own voice again —
 * the user's agent owns the conversation. So most of these are onboarding /
 * gate messages only.
 */

export const copy = {
  greeting: (firstName?: string) => {
    const name = firstName ? `, ${firstName}` : "";
    return (
      `👋 Hey${name}! I'm MsgSchool — a Telegram agent that helps with school. You pick what data I get to see; I work within whatever you share.\n\n` +
      `🟢 **Tutoring** — no credentials needed. Quiz me, walk me through a prompt, explain a concept. I'll coach, not write your work.\n\n` +
      `🔵 **Scope 1: Canvas API** — *the easiest and most important.* Assignments, due dates, Canvas-side grades, modules, syllabus, files, calendar.\n` +
      `**You provide:** Canvas URL + API token.\n\n` +
      `🟡 **Scope 2: Canvas credentials** — conflict resolution. Add if you want to let MsgSchool check that what you see is what we see.\n` +
      `**You provide:** Canvas sign-on credentials.\n\n` +
      `🟣 **Scope 3: Skyward credentials** — final report-card grades, attendance, behavior/discipline reports, term history. Skyward is the system of record for the official grade. Together with Scope 1, lets you see when an assignment was handed in but not graded by the teacher. Also surfaces tardies, absences, and disciplinary issues.\n` +
      `**You provide:** Skyward sign-on credentials.\n\n` +
      `**How I answer:** I work with the scope you provide. If I can't answer your question, I'll let you know why.\n\n` +
      `**Your privacy:** we encrypt your credentials at rest with a hardware-bound key and decrypt them only inside an isolated tool daemon — your agent never holds your password or token, only the data it fetches with it. Your workspace is yours alone; it's not shared with anyone, and the agent inside it works for you and only for you. Read https://msgschool.com/security for the full architecture.\n\n` +
      `**Removing your account:** type \`/delete\` anytime. We delete your stored data and the agent's memory. You can come back anytime by sending a message and a fresh registration code.\n\n` +
      `To start, send me the code \`FreeAgent2026\`.`
    );
  },

  configuring:
    `⚙️ Configuring your agent — hang on for their greeting.`,

  invalidCode:
    `❌ That code didn't work.\n\n` +
    `Double-check spelling. The code right now is \`FreeAgent2026\` (case-sensitive).`,

  codeAlreadyRedeemed: (expiresAt: Date) =>
    `You're already active through *${expiresAt.toDateString()}*. No need to redeem again.`,

  provisioningFailed:
    `Something went wrong setting up your agent. We've been notified — try again in a few minutes.`,

  expired:
    `⌛ Your access expired.\n\n` +
    `If you want to extend, reply *extend* and we'll sort it.`,

  preRegRemaining: (remaining: number) =>
    `${remaining} messages left before I ask for a registration code. Use \`FreeAgent2026\` when you're ready.`,

  preRegExhausted:
    `You've used your 3 intro messages.\n\n` +
    `Send me the code \`FreeAgent2026\` to register and unlock the full agent.`,
};
