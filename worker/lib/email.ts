import type { Env } from "../env";
import type { Plan } from "../../shared/types";
import { escapeHtml } from "./util";

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
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
      from: input.from || env.EMAIL_FROM,
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
export function emailLayout(opts: { title: string; bodyHtml: string; cta?: { label: string; url: string }; footer?: string; brand?: string }): string {
  const cta = opts.cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(opts.cta.url)}" style="background:#1f1d1a;color:#fbfaf7;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(opts.cta.label)}</a></p>`
    : "";
  return `<!doctype html><html lang="no"><body style="margin:0;background:#f4f1ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;color:#1f1d1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fbfaf7;border:1px solid #e4ded4;border-radius:12px;padding:32px">
<tr><td>
<div style="font-weight:700;font-size:18px;letter-spacing:-0.01em;margin-bottom:24px">
<span style="display:inline-block;width:10px;height:10px;background:#b4652b;border-radius:2px;margin-right:8px"></span>${escapeHtml(opts.brand ?? "Plank")}</div>
<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px">${escapeHtml(opts.title)}</h1>
<div style="font-size:15px;line-height:1.6">${opts.bodyHtml}</div>
${cta}
<p style="font-size:12px;color:#7a7368;margin-top:32px">${opts.footer ?? `Sendt fra ${escapeHtml(opts.brand ?? "Plank")} – AI-arbeidsflate for FDV.`}</p>
</td></tr></table></td></tr></table></body></html>`;
}

/** Invitasjon til å prøve Plank, med lenke som varer i 48 timer. */
export function demoInviteEmail(url: string): { subject: string; html: string; text: string } {
  const body =
    "<p>Noen mener du bør se Plank – arbeidsflaten for forvaltning, drift og vedlikehold.</p>" +
    "<p>Porteføljen ligger til venstre, dokumentene og FDV-registeret i midten, og agentene til høyre. De leser FDV-dokumentasjonen, holder oversikten oppdatert og svarer på spørsmål om byggene. Du kan også spørre mot BIM-modellen og lage egne sider med levende data.</p>" +
    "<p>Knappen under logger deg inn. Lenken varer i <b>48 timer</b> og kan brukes én gang. Første gang du åpner den, får du en ferdig demoportefølje – eiendommer, dokumenter, oppgaver og en modell – så du kan klikke deg rundt med en gang.</p>";
  const text = [
    "Noen mener du bør se Plank – arbeidsflaten for forvaltning, drift og vedlikehold.",
    "",
    "Agentene leser FDV-dokumentasjonen, holder oversikten oppdatert og svarer på spørsmål om byggene. Du kan også spørre mot BIM-modellen og lage egne sider med levende data.",
    "",
    "Åpne demoen (gyldig i 48 timer, kan brukes én gang):",
    url,
    "",
    "Første gang du åpner lenken, får du en ferdig demoportefølje å klikke deg rundt i.",
  ].join("\n");
  return {
    subject: "Prøv Plank – FDV med agenter som kjenner byggene",
    html: emailLayout({
      title: "Du er invitert til å prøve Plank",
      bodyHtml: body,
      cta: { label: "Åpne demoen", url },
      footer: "Lenken er gyldig i 48 timer. Hvis du ikke kjenner avsenderen, kan du se bort fra e-posten.",
    }),
    text,
  };
}

const nok = (n: number) => `${n.toLocaleString("nb-NO")} kr`;

export function subscriptionStartedEmail(orgName: string, plan: Plan, url: string): { subject: string; html: string; text: string } {
  const body =
    `<p>Abonnementet for <b>${escapeHtml(orgName)}</b> er i gang, på ${plan.name}.</p>` +
    `<p>${plan.name} koster <b>${nok(plan.priceNok)}/mnd inkl. mva</b> og dekker inntil ${plan.buildings} bygg. <b>${nok(plan.includedAiNok)} AI-bruk</b> følger med hver måned. Det som går over, kommer på neste faktura, og du kan sette en øvre grense under Abonnement.</p>` +
    "<p>Du kan invitere kollegaer fra innstillingene.</p>";
  const text = [
    `Abonnementet for ${orgName} er i gang, på ${plan.name}.`,
    "",
    `${plan.name} koster ${nok(plan.priceNok)}/mnd inkl. mva og dekker inntil ${plan.buildings} bygg.`,
    `${nok(plan.includedAiNok)} AI-bruk følger med hver måned. Det som går over, kommer på neste faktura, og du kan sette en øvre grense under Abonnement.`,
    "",
    url,
  ].join("\n");
  return {
    subject: "Abonnementet i Plank er i gang",
    html: emailLayout({
      title: "Abonnementet er i gang",
      bodyHtml: body,
      cta: { label: "Åpne Plank", url },
      footer: "Beløpene er inkl. mva. Kvitteringen kommer fra Stripe.",
    }),
    text,
  };
}

/** Varsel om månedsgrensen for ekstra AI-bruk: ved 80 % og når agentene settes på pause */
export function spendLimitEmail(opts: {
  kind: "warn" | "reached";
  orgName: string;
  limitOre: number;
  extraOre: number;
  resumesAt: number;
  url: string;
}): { subject: string; html: string; text: string } {
  const limit = nok(Math.round(opts.limitOre / 100));
  const extra = nok(Math.round(opts.extraOre / 100));
  const resumes = new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", day: "numeric", month: "long" }).format(new Date(opts.resumesAt));
  const org = escapeHtml(opts.orgName);
  const lines =
    opts.kind === "warn"
      ? [
          `${opts.orgName} har brukt ${extra} av grensen på ${limit} for ekstra AI-bruk denne måneden.`,
          "Når grensen er nådd, settes agentene på pause til neste måned. Du kan heve grensen under Abonnement.",
        ]
      : opts.limitOre > 0
        ? [
            `${opts.orgName} har nådd grensen på ${limit} for ekstra AI-bruk denne måneden.`,
            `Agentene er satt på pause til ${resumes}. Hever du grensen, er de i gang igjen med en gang.`,
          ]
        : [
            `${opts.orgName} har brukt opp AI-bruken som følger med måneden, og grensen for ekstra bruk er 0 kr.`,
            `Agentene er satt på pause til ${resumes}. Hever du grensen, er de i gang igjen med en gang.`,
          ];
  return {
    subject: opts.kind === "warn" ? `${opts.orgName} nærmer seg grensen for AI-bruk` : `Agentene i ${opts.orgName} er satt på pause`,
    html: emailLayout({
      title: opts.kind === "warn" ? "Nærmer seg grensen for AI-bruk" : "Agentene er satt på pause",
      bodyHtml: lines.map((l) => `<p>${escapeHtml(l).replace(escapeHtml(opts.orgName), `<b>${org}</b>`)}</p>`).join(""),
      cta: { label: opts.kind === "warn" ? "Se bruken" : "Hev grensen", url: opts.url },
      footer: "Du får denne e-posten fordi du er administrator i organisasjonen. Beløpene er inkl. mva.",
    }),
    text: [...lines, "", opts.url].join("\n"),
  };
}

/** Første LAFT-innlogging for en e-postadresse som allerede har en Plank-konto */
export function laftLinkEmail(url: string, laftLabel: string, brand = "Plank"): { subject: string; html: string; text: string } {
  return {
    subject: `Bekreft innlogging i ${brand}`,
    html: emailLayout({
      brand,
      title: "Bekreft innloggingen",
      bodyHtml: `<p>Noen logget nettopp inn i ${escapeHtml(brand)} med kontoen din (${escapeHtml(laftLabel)}). Siden du allerede har en konto på denne adressen, må du bekrefte at det var deg.</p><p>Etterpå kan du logge inn direkte. Lenken er gyldig i 15 minutter.</p>`,
      cta: { label: "Bekreft og logg inn", url },
      footer: "Var det ikke deg? Da kan du ignorere e-posten – ingenting blir koblet.",
    }),
    text: `Bekreft innlogging i ${brand} (${laftLabel}): ${url}\n\nLenken er gyldig i 15 minutter. Var det ikke deg, kan du ignorere e-posten.`,
  };
}

/** Invitasjon til en organisasjon, med hva personen får tilgang til */
export function memberInviteEmail(opts: {
  inviter: string;
  orgName: string;
  brand: string;
  level: string;
  places: string[] | null;
  expires: string | null;
  message?: string | null;
  url: string;
}): { subject: string; html: string; text: string } {
  const shown = opts.places?.slice(0, 12) ?? [];
  const more = (opts.places?.length ?? 0) - shown.length;
  const scopeHtml = opts.places
    ? `<ul style="margin:4px 0 0;padding-left:18px">${shown.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}${more > 0 ? `<li>og ${more} til</li>` : ""}</ul>`
    : "Hele porteføljen";
  const row = (label: string, value: string) =>
    `<tr><td style="padding:10px 0;border-top:1px solid #e4ded4;color:#7a7368;width:110px;vertical-align:top">${label}</td><td style="padding:10px 0;border-top:1px solid #e4ded4">${value}</td></tr>`;
  const message = opts.message?.trim()
    ? `<div style="margin:20px 0;padding:14px 16px;background:#f4f1ec;border-radius:8px;white-space:pre-wrap">${escapeHtml(opts.message.trim())}</div>`
    : "";
  return {
    subject: `${opts.inviter} har gitt deg tilgang til ${opts.orgName}`,
    html: emailLayout({
      brand: opts.brand,
      title: `Velkommen til ${opts.orgName}`,
      bodyHtml: `<p>${escapeHtml(opts.inviter)} har gitt deg tilgang til <b>${escapeHtml(opts.orgName)}</b> i ${escapeHtml(opts.brand)} – arbeidsflaten for forvaltning, drift og vedlikehold med AI-agenter.</p>
${message}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:8px">
${row("Tilgang", escapeHtml(opts.level))}
${row("Omfang", scopeHtml)}
${row("Varighet", opts.expires ? `Til og med ${escapeHtml(opts.expires)}` : "Ingen sluttdato")}
</table>`,
      cta: { label: `Åpne ${opts.orgName}`, url: opts.url },
      footer: "Lenken logger deg rett inn og er gyldig i 7 dager. Senere logger du inn med denne e-postadressen.",
    }),
    text: [
      `${opts.inviter} har gitt deg tilgang til ${opts.orgName} i ${opts.brand}.`,
      opts.message?.trim() ? `\n«${opts.message.trim()}»\n` : "",
      `Tilgang: ${opts.level}`,
      `Omfang: ${opts.places ? opts.places.join(", ") : "Hele porteføljen"}`,
      `Varighet: ${opts.expires ? `til og med ${opts.expires}` : "ingen sluttdato"}`,
      "",
      opts.url,
    ].join("\n"),
  };
}

export function magicLinkEmail(url: string, brand = "Plank"): { subject: string; html: string; text: string } {
  return {
    subject: `Logg inn i ${brand}`,
    html: emailLayout({
      brand,
      title: `Logg inn i ${brand}`,
      bodyHtml: "<p>Klikk på knappen under for å logge inn. Lenken er gyldig i 15 minutter og kan bare brukes én gang.</p>",
      cta: { label: "Logg inn", url },
      footer: "Hvis du ikke ba om denne e-posten, kan du trygt ignorere den.",
    }),
    text: `Logg inn i ${brand}: ${url}\n\nLenken er gyldig i 15 minutter.`,
  };
}
