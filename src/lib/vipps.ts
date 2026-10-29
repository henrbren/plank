import { api } from "./api";

export async function startVippsLogin(next?: string | null) {
  const cfg = await api<{ clientId: string; callback: string }>("/auth/vipps/config");
  const csrf = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const verifier = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const appRedirect = `${window.location.origin}/auth/vipps`;
  const state = `${btoa(appRedirect)}.wv1.${csrf}.${verifier}`;
  if (next) sessionStorage.setItem("plank-next", next);
  const url = new URL("https://api.vipps.no/access-management-1.0/access/oauth2/auth");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid name email phoneNumber address");
  url.searchParams.set("redirect_uri", cfg.callback);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  window.location.href = url.toString();
}
