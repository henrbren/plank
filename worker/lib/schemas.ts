import { z } from "zod";

/** Valgfri tekst: tom streng blir null */
export const optStr = (max = 2000) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null || v.trim() === "" ? null : v.trim()));

export const optNum = () =>
  z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => {
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
      return Number.isFinite(n) ? n : null;
    });

export const optInt = () => optNum().transform((v) => (v == null ? null : Math.round(v)));

export const optDate = () =>
  z
    .string()
    .nullish()
    .transform((v) => (v == null || v.trim() === "" ? null : v.trim().slice(0, 10)))
    .refine((v) => v == null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Dato må være på formatet ÅÅÅÅ-MM-DD");

export const optId = () =>
  z
    .string()
    .max(64)
    .nullish()
    .transform((v) => (v == null || v === "" ? null : v));

export const reqStr = (max = 200) => z.string().trim().min(1, "Påkrevd").max(max);
