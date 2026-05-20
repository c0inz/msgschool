/**
 * Thin wrappers around the Telegram Bot API.
 *
 * We use raw fetch (not grammy) for the outbound side so the webhook handler
 * has zero framework overhead. The inbound Update type we accept is just a
 * subset of what Telegram sends — enough to route onboarding.
 */

const API_BASE = "https://api.telegram.org/bot";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

function token(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

export function botConfigured(): boolean {
  return Boolean(token());
}

export async function sendMessage(chatId: number, text: string, opts: { parseMode?: "Markdown" | "HTML" } = {}) {
  const t = token();
  if (!t) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — would have sent:", { chatId, text });
    return { ok: false, skipped: true };
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (opts.parseMode) body.parse_mode = opts.parseMode;

  const res = await fetch(`${API_BASE}${t}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[telegram] sendMessage FAIL", res.status, "chat=" + chatId, "len=" + text.length, "detail=" + detail.slice(0, 300));
    return { ok: false, status: res.status };
  }
  const respBody = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
  console.log("[telegram] sendMessage ok chat=" + chatId + " message_id=" + (respBody.result?.message_id ?? "?") + " len=" + text.length);
  return { ok: true };
}

/**
 * Send a photo to the chat by URL. The URL must be publicly reachable by
 * Telegram's servers — we host help images at https://msgschool.com/help/*.jpg
 * via the Next.js app's `public/help/` directory, so `{"name":"canvas-token"}`
 * resolves to `https://msgschool.com/help/canvas-token.jpg`.
 *
 * Caption is rendered below the image on the client; keep it short.
 */
export async function sendPhoto(
  chatId: number,
  photoUrl: string,
  caption?: string,
): Promise<{ ok: boolean; status?: number }> {
  const t = token();
  if (!t) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — would have sent photo:", { chatId, photoUrl });
    return { ok: false };
  }

  const body: Record<string, unknown> = { chat_id: chatId, photo: photoUrl };
  if (caption) body.caption = caption;

  const res = await fetch(`${API_BASE}${t}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[telegram] sendPhoto FAIL", res.status, "chat=" + chatId, "url=" + photoUrl, "detail=" + detail.slice(0, 300));
    return { ok: false, status: res.status };
  }
  console.log("[telegram] sendPhoto ok chat=" + chatId + " url=" + photoUrl);
  return { ok: true };
}

/**
 * Delete a message from the chat. Used by the platform credential-capture
 * path to scrub an inbound paste that looks like a credential within ~1s
 * of receipt. Best-effort — Telegram refuses silently for messages older
 * than 48h or when the bot lacks permission. Log on failure and continue.
 */
export async function deleteMessage(chatId: number, messageId: number): Promise<{ ok: boolean; status?: number }> {
  const t = token();
  if (!t) return { ok: false };
  const res = await fetch(`${API_BASE}${t}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[telegram] deleteMessage FAIL", res.status, "chat=" + chatId, "mid=" + messageId, "detail=" + detail.slice(0, 200));
    return { ok: false, status: res.status };
  }
  console.log("[telegram] deleteMessage ok chat=" + chatId + " mid=" + messageId);
  return { ok: true };
}

/**
 * Fire Telegram's typing indicator for the chat. Telegram auto-clears the
 * indicator after ~5 seconds, so callers that want a long typing state
 * should call this on an interval until they're ready to send.
 */
export async function sendChatAction(
  chatId: number,
  action: "typing" | "upload_photo" | "upload_document" = "typing",
): Promise<{ ok: boolean }> {
  const t = token();
  if (!t) return { ok: false };
  try {
    const res = await fetch(`${API_BASE}${t}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

