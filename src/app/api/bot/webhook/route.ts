/**
 * Telegram webhook entrypoint.
 *
 * Telegram POSTs each update here. We ack 200 fast (Telegram retries on
 * non-200) and process the update in the background — no user-facing latency.
 *
 * Secret: Telegram sends our shared secret in the
 * X-Telegram-Bot-Api-Secret-Token header. We reject anything else.
 */

import { NextRequest, NextResponse } from "next/server";
import { handleUpdate } from "@/lib/bot/handler";
import { botConfigured, TelegramUpdate } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret) {
    const header = req.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      console.warn("[webhook] bad secret");
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  if (!botConfigured()) {
    console.warn("[webhook] TELEGRAM_BOT_TOKEN not configured; dropping update");
    // Still 200 so Telegram doesn't retry in perpetuity.
    return NextResponse.json({ ok: true, skipped: "bot_not_configured" });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  // Fire-and-forget: ack Telegram immediately so it doesn't retry, then process.
  queueMicrotask(() => {
    handleUpdate(update).catch((err) => {
      console.error("[webhook] handler crashed:", err);
    });
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "telegram-webhook" });
}
