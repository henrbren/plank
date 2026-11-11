import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Map as MapIcon } from "lucide-react";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import type { PropertyMap, PropertyMapPoint } from "@shared/types";
import { useOrg, useOrgQuery, useSetFocus } from "@/lib/app";
import { Card, EmptyState, ErrorState, Loading, PageHeader, cn } from "@/components/ui";
import "leaflet/dist/leaflet.css";

const TILES = "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png";

function placeLine(point: PropertyMapPoint): string | null {
  if (!point.address) return null;
  const rest = [point.postal_code, point.city].filter(Boolean).join(" ");
  return rest ? `${point.address}, ${rest}` : point.address;
}

function statusLine(point: PropertyMapPoint): string {
  if (point.geo === "pending") return "Slår opp adressen …";
  if (point.geo === "miss") return "Fant ikke adressen i matrikkelen";
  if (point.geo === "none") return "Mangler adresse";
  const buildings = point.building_count === 1 ? "1 bygg" : `${point.building_count} bygg`;
  return point.address_from === "building" ? `${buildings} · adressen er fra bygget` : buildings;
}

export default function MapPage() {
  const { orgId } = useOrg();
  useSetFocus("org", undefined, "Kart");
  const query = useOrgQuery<PropertyMap>("/portfolio/map", {
    refetchInterval: (q) => (q.state.data?.pending ? 1200 : false),
  });
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ map: LeafletMap; layer: LayerGroup } | null>(null);
  const pointsRef = useRef<PropertyMapPoint[]>([]);
  const selectedRef = useRef<string | null>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const points = query.data?.points ?? [];
  pointsRef.current = points;
  selectedRef.current = selected;

  const select = (id: string) => {
    setSelected(id);
    const point = pointsRef.current.find((p) => p.id === id);
    const ctx = mapRef.current;
    if (!ctx || point?.lat == null || point.lon == null) return;
    ctx.map.flyTo([point.lat, point.lon], Math.max(ctx.map.getZoom(), 15), { duration: 0.5 });
    document.getElementById(`kart-${id}`)?.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    const el = mapEl.current;
    if (!el || query.isLoading || query.error) return;
    let dead = false;
    let observer: ResizeObserver | undefined;
    void import("leaflet").then((mod) => {
      if (dead || !mapEl.current) return;
      const L = mod;
      const map = L.map(mapEl.current, { zoomControl: true }).setView([65, 12], 4);
      L.tileLayer(TILES, {
        attribution: '© <a href="https://www.kartverket.no/">Kartverket</a>',
        maxZoom: 18,
        minZoom: 3,
      }).addTo(map);
      const layer = L.layerGroup().addTo(map);
      mapRef.current = { map, layer };
      observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(mapEl.current);
      setReady(true);
    });
    return () => {
      dead = true;
      observer?.disconnect();
      mapRef.current?.map.remove();
      mapRef.current = null;
      fitted.current = false;
      setReady(false);
    };
  }, [query.isLoading, query.error]);

  useEffect(() => {
    const ctx = mapRef.current;
    if (!ctx || !ready) return;
    void import("leaflet").then((L) => {
      if (mapRef.current !== ctx) return;
      ctx.layer.clearLayers();
      const style = getComputedStyle(document.documentElement);
      const accent = style.getPropertyValue("--accent").trim() || "#a65b24";
      const ink = style.getPropertyValue("--ink").trim() || "#1d1b18";
      const pins = points.filter((p) => p.lat != null && p.lon != null);
      for (const point of pins) {
        const on = point.id === selected;
        const marker = L.circleMarker([point.lat!, point.lon!], {
          radius: on ? 9 : 7,
          color: "#ffffff",
          weight: 2,
          fillColor: on ? ink : accent,
          fillOpacity: 1,
        });
        marker.bindTooltip(point.name, { direction: "top", offset: [0, -4] });
        marker.on("click", () => select(point.id));
        marker.addTo(ctx.layer);
      }
      if (!fitted.current && pins.length > 0) {
        if (pins.length === 1) ctx.map.setView([pins[0]!.lat!, pins[0]!.lon!], 14);
        else ctx.map.fitBounds(L.latLngBounds(pins.map((p) => [p.lat!, p.lon!] as [number, number])), { padding: [36, 36], maxZoom: 14 });
        fitted.current = true;
      }
    });
    // select er stabil nok: den leser refs. selected og points styrer tegningen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, selected, ready]);

  if (query.isLoading) return <Loading label="Laster kart …" />;
  if (query.error) return <ErrorState error={query.error} />;
  const data = query.data!;
  const placed = data.points.filter((p) => p.geo === "ok").length;
  const base = `/o/${orgId}`;

  return (
    <div className="px-5 py-7 sm:px-8">
      <PageHeader
        icon={<MapIcon className="size-5" />}
        title="Kart"
        subtitle={
          data.points.length === 0
            ? "Hvor eiendommene ligger"
            : `${data.points.length === 1 ? "1 eiendom" : `${data.points.length} eiendommer`} · ${placed} på kartet`
        }
      />
      {data.warning && <div className="mb-4 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">{data.warning}</div>}
      {data.points.length === 0 ? (
        <EmptyState icon={<MapIcon className="size-5" />} title="Ingen eiendommer å vise" description="Når eiendommene har en adresse, vises de på kartet." />
      ) : (
        <div className="grid items-start gap-4 @3xl:h-[calc(100svh-11rem)] @3xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="plank-map isolate h-[420px] overflow-hidden rounded-xl border border-line @3xl:h-full" ref={mapEl} />
          <Card padded={false} className="flex max-h-[420px] min-h-0 flex-col @3xl:h-full @3xl:max-h-none">
            <ul className="min-h-0 flex-1 overflow-y-auto p-2">
              {data.points.map((point) => (
                <li key={point.id} id={`kart-${point.id}`}>
                  <div className={cn("flex items-start gap-2 rounded-lg px-2 py-2", selected === point.id && "bg-panel-2")}>
                    <button type="button" onClick={() => select(point.id)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-[13.5px] font-medium">{point.name}</span>
                      <span className="block truncate text-[12px] text-muted">{placeLine(point) ?? "Ingen adresse"}</span>
                      <span className={cn("block text-[12px]", point.geo === "miss" ? "text-warn" : "text-muted")}>{statusLine(point)}</span>
                    </button>
                    <Link to={`${base}/properties/${point.id}`} className="shrink-0 pt-0.5 text-[12px] text-muted hover:text-ink">
                      Åpne
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
            <div className="border-t border-line px-3 py-2 text-[11.5px] text-muted">Adresser fra Kartverket</div>
          </Card>
        </div>
      )}
    </div>
  );
}
