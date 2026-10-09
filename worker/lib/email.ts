import type { Env } from "../env";
import { escapeHtml } from "./util";

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  idempotencyKey?: string;
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY);
}

/** Sender e-post via Resend. Kaster ved feil. */
export async function sendEmail(env: Env, input: SendEmailInput): Promise<{ id: string }> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY er ikke satt – kan ikke sende e-post");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.RESEND_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
      reply_to: input.replyTo,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend svarte ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as { id: string };
}

/** Felles, enkel e-postlayout */
export function emailLayout(opts: { title: string; bodyHtml: string; cta?: { label: string; url: string }; footer?: string }): string {
  const cta = opts.cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(opts.cta.url)}" style="background:#1f1d1a;color:#fbfaf7;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(opts.cta.label)}</a></p>`
    : "";
  return `<!doctype html><html lang="no"><body style="margin:0;background:#f4f1ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;color:#1f1d1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fbfaf7;border:1px solid #e4ded4;border-radius:12px;padding:32px">
<tr><td>
<div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;margin-bottom:24px">
<span style="display:inline-block;width:10px;height:10px;background:#b4652b;border-radius:2px;margin-right:8px"></span>Plank</div>
<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px">${escapeHtml(opts.title)}</h1>
<div style="font-size:15px;line-height:1.6">${opts.bodyHtml}</div>
${cta}
<p style="font-size:12px;color:#7a7368;margin-top:32px">${opts.footer ?? "Sendt fra Plank – AI-arbeidsflate for FDV."}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function magicLinkEmail(url: string): { subject: string; html: string; text: string } {
  return {
    subject: "Logg inn i Plank",
    html: emailLayout({
      title: "Logg inn i Plank",
      bodyHtml: "<p>Klikk på knappen under for å logge inn. Lenken er gyldig i 15 minutter og kan bare brukes én gang.</p>",
      cta: { label: "Logg inn", url },
      footer: "Hvis du ikke ba om denne e-posten, kan du trygt ignorere den.",
    }),
    text: `Logg inn i Plank: ${url}\n\nLenken er gyldig i 15 minutter.`,
  };
}
