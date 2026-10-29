import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BRANDS, brandFromHost, resolveBrand, type Brand, type BrandId } from "@shared/brand";

const STORAGE_KEY = "plank-brand";

interface BrandState {
  brand: Brand;
  /** Kom brukeren inn via et LAFT-domene? Da finnes merkevarevalget og Vipps. */
  laftHost: boolean;
  choose: (id: Exclude<BrandId, "plank">) => void;
}

const BrandCtx = createContext<BrandState>({ brand: BRANDS.plank, laftHost: false, choose: () => undefined });

function storedChoice(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function applyBrand(brand: Brand) {
  const root = document.documentElement;
  if (brand.id === "plank") delete root.dataset.brand;
  else root.dataset.brand = brand.id;
  document.title = brand.name;
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const laftHost = useMemo(() => brandFromHost(window.location.hostname).id !== "plank", []);
  const [brand, setBrand] = useState(() => resolveBrand(window.location.hostname, storedChoice()));

  useEffect(() => applyBrand(brand), [brand]);

  const choose = useCallback(
    (id: Exclude<BrandId, "plank">) => {
      if (!laftHost) return;
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch {
        /* ignorer */
      }
      setBrand(BRANDS[id]);
    },
    [laftHost],
  );

  const value = useMemo(() => ({ brand, laftHost, choose }), [brand, laftHost, choose]);
  return <BrandCtx.Provider value={value}>{children}</BrandCtx.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandCtx).brand;
}

export function useBrandState(): BrandState {
  return useContext(BrandCtx);
}
