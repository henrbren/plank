import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  Bell,
  Bot,
  Building2,
  Calendar,
  ChevronRight,
  ChevronsUpDown,
  ClipboardList,
  CreditCard,
  DoorOpen,
  Droplets,
  Eye,
  FileText,
  Flame,
  FolderTree,
  Gauge,
  CircleHelp,
  House,
  KeyRound,
  Layers,
  LayoutDashboard,
  Leaf,
  ListChecks,
  LogOut,
  Map,
  MapPin,
  Menu as MenuIcon,
  Monitor,
  Moon,
  PanelRightOpen,
  Shield,
  Plus,
  Search,
  Settings,
  SquareCheck,
  Star,
  Sun,
  Table,
  Thermometer,
  UserPlus,
  Users,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Member, SidebarPage, TreeProperty } from "@shared/types";
import { placeImageUrl } from "@/features/places/PlacePhoto";
import { UsageMeter } from "@/features/billing/UsageMeter";
import { BackgroundImport } from "@/features/onboarding/Funnel";
import { useBrand } from "@/lib/brand";
import { useNavFlags } from "@/lib/modules";
import { AgentPanelProvider, FocusProvider, OrgProvider, useAgentPanel, useMe, useOrg, useOrgQuery, useTheme } from "@/lib/app";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Logo } from "./domain";
import { cn, IconButton, Loading, Menu, MenuItem } from "./ui";
import { AgentPanel } from "@/features/chat/AgentPanel";
import { NextStepBar } from "@/features/onboarding/NextStep";
import { StartGuideProvider, useOpenGuide } from "@/features/onboarding/StartGuide";
import { CommandPalette } from "./CommandPalette";
import { PropertyFormModal } from "./forms";
import { InviteModal } from "@/pages/access";

export function OrgLayout() {
  const { orgId } = useParams();
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (me.error || !me.data) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  const org = me.data.orgs.find((o) => o.id === orgId);
  if (!org) return <Navigate to="/" replace />;
  try {
    localStorage.setItem("plank-last-org", org.id);
  } catch {
    /* ignorer */
  }
  return (
    <OrgProvider value={{ orgId: org.id, org, me: me.data, isAdmin: org.role !== "member", canEdit: org.can_edit !== false, limited: Boolean(org.limited) }}>
      <FocusProvider>
        <AgentPanelProvider orgId={org.id}>
          <Shell />
        </AgentPanelProvider>
      </FocusProvider>
    </OrgProvider>
  );
}

function Shell() {
  const panel = useAgentPanel();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const onArtifact = /\/artifacts\/[^/]+$/.test(location.pathname);

  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    if (params.get("oppsett") !== "1") return;
    const next = new URLSearchParams(params);
    next.delete("oppsett");
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        panel.setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [panel]);

  return (
    <StartGuideProvider>
    <div className="flex h-full overflow-hidden">
      {/* Sidepanel */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-[264px] shrink-0 border-r border-nav-line bg-nav text-nav-ink transition-transform lg:static lg:translate-x-0",
          navOpen ? "translate-x-0 shadow-pop" : "-translate-x-full",
        )}
      >
        <Sidebar onSearch={() => setPaletteOpen(true)} />
      </aside>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setNavOpen(false)} />}

      {/* Hovedinnhold */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 lg:hidden">
          <IconButton label="Meny" onClick={() => setNavOpen(true)}>
            <MenuIcon className="size-5" />
          </IconButton>
          <Logo />
          <div className="flex-1" />
          <IconButton label="Søk" onClick={() => setPaletteOpen(true)}>
            <Search className="size-4.5" />
          </IconButton>
          <IconButton label="Agent" onClick={() => panel.setOpen(true)}>
            <PanelRightOpen className="size-4.5" />
          </IconButton>
        </div>
        <div className={cn("@container min-h-0 flex-1 overflow-y-auto", !panel.open && !onArtifact && "lg:pb-20")}>
          <NextStepBar />
          <Outlet />
        </div>
      </main>

      {/* Agentpanel */}
      <AgentPanel />
      {!panel.open && !onArtifact && (
        <button
          onClick={() => panel.setOpen(true)}
          className="fixed right-5 bottom-5 z-20 hidden items-center gap-2 rounded-full border border-line bg-ink px-4 py-2.5 text-[13.5px] font-medium text-bg shadow-pop transition-transform hover:scale-[1.03] lg:flex"
        >
          <Bot className="size-4" />
          Spør en agent
          <kbd className="ml-1 rounded bg-bg/15 px-1.5 text-[11px]">⌘J</kbd>
        </button>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
    </StartGuideProvider>
  );
}

function NavItem({ to, icon, label, end, className, forceActive }: { to: string; icon: React.ReactNode; label: string; end?: boolean; className?: string; forceActive?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cn(
          "flex h-7.5 w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-lg px-2.5 text-[13.5px] transition-colors",
          className,
          isActive || forceActive
            ? "bg-nav-active font-medium text-nav-ink"
            : "text-nav-ink-2 hover:bg-nav-hover hover:text-nav-ink",
        )
      }
    >
      <span className="shrink-0 text-nav-muted [&>svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </NavLink>
  );
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { orgId, org, me, isAdmin, canEdit, limited } = useOrg();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const panel = useAgentPanel();
  const openGuide = useOpenGuide();
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");
  const nav = useNavFlags();
  const brand = useBrand();
  const [newProperty, setNewProperty] = useState(false);
  const [invite, setInvite] = useState(false);
  const members = useOrgQuery<Member[]>(isAdmin ? "/members" : null);
  const solo = isAdmin && members.data?.length === 1;
  const base = `/o/${orgId}`;

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    qc.clear();
    navigate("/login");
  };

  return (
    <div className="flex h-full flex-col">
      {/* Org-velger */}
      <div className="p-2.5">
        <Menu
          align="start"
          className="w-full"
          trigger={() => (
            <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-nav-hover">
              <Logo withText={false} className={brand.logo ? "[&_img]:rounded-md [&_img]:bg-white [&_img]:p-0.5" : undefined} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{org.name}</span>
                <span className="block text-[11.5px] text-nav-muted">{brand.name}</span>
              </span>
              <ChevronsUpDown className="size-4 text-nav-muted" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-muted">Organisasjoner</div>
              {me.orgs.map((o) => (
                <MenuItem
                  key={o.id}
                  active={o.id === orgId}
                  onClick={() => {
                    close();
                    navigate(`/o/${o.id}`);
                  }}
                >
                  {o.name}
                </MenuItem>
              ))}
              <div className="my-1 border-t border-line" />
              <MenuItem
                icon={<Plus className="size-4" />}
                onClick={() => {
                  close();
                  navigate("/onboarding");
                }}
              >
                Ny organisasjon
              </MenuItem>
            </>
          )}
        </Menu>
      </div>

      <div className="px-2.5">
        <button onClick={onSearch} className="flex h-8 w-full items-center gap-2 rounded-lg border border-nav-line bg-nav-field px-2.5 text-[13px] text-nav-muted hover:bg-nav-hover">
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Søk …</span>
          <kbd className="rounded border border-nav-line px-1 text-[10.5px]">⌘K</kbd>
        </button>
      </div>
      {(!canEdit || limited || org.expires_on) && (
        <div className="mx-2.5 mt-2 flex items-start gap-2 rounded-lg bg-info-soft px-2.5 py-2 text-[12px] leading-snug text-info">
          {canEdit ? <Building2 className="mt-px size-3.5 shrink-0" /> : <Eye className="mt-px size-3.5 shrink-0" />}
          <span>
            {!canEdit ? "Du har lesetilgang" : limited ? "Du ser utvalgte eiendommer og bygg" : "Du har tilgang"}
            {!canEdit && limited ? " til utvalgte eiendommer og bygg" : ""}
            {org.expires_on ? ` til og med ${formatDate(org.expires_on)}` : ""}.
          </span>
        </div>
      )}

      <nav className="mt-3 flex min-w-0 flex-col gap-0.5 overflow-x-hidden px-2.5">
        {nav.lease ? (
          <NavItem to={base} end icon={<House />} label="Pult" forceActive={location.pathname.startsWith(`${base}/pult/`)} />
        ) : (
          <NavItem to={base} end icon={<House />} label="Oversikt" />
        )}
        {nav.utleie && !nav.lease && <NavItem to={`${base}/pult`} icon={<KeyRound />} label="Pult" forceActive={location.pathname.startsWith(`${base}/pult/`)} />}
        {nav.lease && nav.drift && <NavItem to={`${base}/drift`} icon={<BarChart3 />} label="Drift" />}
        {nav.kart && <NavItem to={`${base}/kart`} icon={<Map />} label="Kart" />}
        {nav.tasks && <NavItem to={`${base}/tasks`} icon={<SquareCheck />} label="Oppgaver" />}
        {nav.dokumenter && <NavItem to={`${base}/documents`} icon={<FileText />} label="Dokumenter" />}
        {nav.komponenter && <NavItem to={`${base}/components`} icon={<Wrench />} label="Komponenter" />}
        {nav.sider && <NavItem to={`${base}/artifacts`} icon={<LayoutDashboard />} label="Sider" />}
        {nav.pinned && <SidebarPages />}
      </nav>

      <Portfolio tree={tree.data} canAdd={canEdit && !limited} limited={limited} onNewProperty={() => setNewProperty(true)} base={base} />

      <div className="border-t border-nav-line px-2.5 pt-1.5">
        <BackgroundImport orgId={orgId} />
        <UsageMeter />
      </div>
      {/* Bruker */}
      <div className="p-2.5">
        {solo && (
          <button
            type="button"
            onClick={() => setInvite(true)}
            className="mb-1.5 flex h-8 w-full items-center gap-2 rounded-lg border border-nav-line px-2.5 text-[13px] text-nav-ink hover:bg-nav-hover"
          >
            <UserPlus className="size-3.5 shrink-0 text-nav-muted" />
            Inviter
          </button>
        )}
        <Menu
          align="start"
          className="w-full"
          trigger={() => (
            <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-nav-hover">
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-[12px] font-semibold uppercase",
                  brand.id === "plank" ? "bg-accent-soft text-accent" : "bg-white/15 text-white",
                )}
              >
                {(me.user.name ?? me.user.email).slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{me.user.name ?? me.user.email}</span>
            </button>
          )}
        >
          {(close) => (
            <>
              {me.platformAdmin && (
                <MenuItem
                  icon={<Shield className="size-4" />}
                  onClick={() => {
                    close();
                    navigate("/admin");
                  }}
                >
                  Kunder
                </MenuItem>
              )}
              <MenuItem
                icon={<CircleHelp className="size-4" />}
                onClick={() => {
                  close();
                  openGuide();
                }}
              >
                Kom i gang
              </MenuItem>
              <MenuItem
                icon={<CircleHelp className="size-4" />}
                active={location.pathname.startsWith(`${base}/hjelp`)}
                onClick={() => {
                  close();
                  navigate(`${base}/hjelp`);
                }}
              >
                Hjelp
              </MenuItem>
              <MenuItem
                icon={<Settings className="size-4" />}
                onClick={() => {
                  close();
                  navigate(`${base}/settings`);
                }}
              >
                Innstillinger
              </MenuItem>
              <MenuItem
                icon={<Users className="size-4" />}
                onClick={() => {
                  close();
                  navigate(`${base}/tilganger`);
                }}
              >
                Brukere og tilganger
              </MenuItem>
              {isAdmin && (
                <MenuItem
                  icon={<CreditCard className="size-4" />}
                  onClick={() => {
                    close();
                    navigate(`${base}/abonnement`);
                  }}
                >
                  Abonnement og bruk
                </MenuItem>
              )}
              {!limited && (
                <>
                  <MenuItem
                    icon={<KeyRound className="size-4" />}
                    onClick={() => {
                      close();
                      navigate(`${base}/laft`);
                    }}
                  >
                    LAFT
                  </MenuItem>
                  <MenuItem
                    icon={<FolderTree className="size-4" />}
                    onClick={() => {
                      close();
                      navigate(`${base}/boligmappa`);
                    }}
                  >
                    Boligmappa
                  </MenuItem>
                </>
              )}
              <MenuItem
                icon={<PanelRightOpen className="size-4" />}
                onClick={() => {
                  close();
                  panel.setOpen((o) => !o);
                }}
              >
                Vis/skjul agentpanel
              </MenuItem>
              <div className="my-1 border-t border-line" />
              <div className="flex gap-1 px-1.5 py-1">
                {(
                  [
                    ["system", <Monitor key="s" className="size-3.5" />, "System"],
                    ["light", <Sun key="l" className="size-3.5" />, "Lyst"],
                    ["dark", <Moon key="d" className="size-3.5" />, "Mørkt"],
                  ] as const
                ).map(([value, icon, label]) => (
                  <button
                    key={value}
                    onClick={() => setTheme(value)}
                    className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-md py-1 text-[12px]", theme === value ? "bg-panel-2 text-ink" : "text-muted hover:text-ink")}
                  >
                    {icon}
                    {label}
                  </button>
                ))}
              </div>
              <div className="my-1 border-t border-line" />
              <MenuItem icon={<LogOut className="size-4" />} onClick={logout}>
                Logg ut
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      <PropertyFormModal open={newProperty} onClose={() => setNewProperty(false)} />
      {invite && <InviteModal onClose={() => setInvite(false)} />}
    </div>
  );
}

const PAGE_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  chart: BarChart3,
  calendar: Calendar,
  checklist: ListChecks,
  wrench: Wrench,
  flame: Flame,
  shield: Shield,
  building: Building2,
  map: Map,
  file: FileText,
  gauge: Gauge,
  bell: Bell,
  zap: Zap,
  droplet: Droplets,
  thermometer: Thermometer,
  leaf: Leaf,
  users: Users,
  table: Table,
  star: Star,
  clipboard: ClipboardList,
};

function SidebarPages() {
  const { orgId } = useOrg();
  const pages = useOrgQuery<SidebarPage[]>("/artifacts/sidebar");
  if (!pages.data?.length) return null;
  return (
    <div className="mt-2 min-w-0">
      <div className="px-2.5 pb-1 text-[11.5px] font-semibold tracking-wide text-nav-muted uppercase">Mine sider</div>
      <div className="sidebar-scroll flex max-h-32 min-w-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto">
        {pages.data.map((p) => {
          const Icon = (p.sidebar_icon && PAGE_ICONS[p.sidebar_icon]) || LayoutDashboard;
          return <NavItem key={p.id} to={`/o/${orgId}/artifacts/${p.id}`} icon={<Icon />} label={p.title} className="pr-10" />;
        })}
      </div>
    </div>
  );
}

// ─── Porteføljetre ───────────────────────────────────────────────────────────

function storedOpen(id: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(`plank-tree-${id}`);
    if (v == null) return fallback;
    return v === "1";
  } catch {
    return fallback;
  }
}

/** `pinOpen` åpner noden når ruta ligger inni den, uten å lagre valget. Ny rute åpner den på nytt. */
function useExpanded(id: string, fallback: boolean, pinOpen: boolean, pinToken: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => storedOpen(id, fallback) || pinOpen);
  useEffect(() => {
    if (pinOpen) setOpen(true);
  }, [pinOpen, pinToken]);
  const toggle = () =>
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(`plank-tree-${id}`, next ? "1" : "0");
      } catch {
        /* ignorer */
      }
      return next;
    });
  return [open, toggle];
}

/** Søket viser treff åpnet, men lar brukeren folde dem igjen uten å skrive til lagringen. */
function useShown(id: string, fallback: boolean, pinOpen: boolean, pinToken: string, revealKey: string): [boolean, () => void] {
  const [open, toggle] = useExpanded(id, fallback, pinOpen, pinToken);
  const [folded, setFolded] = useState(false);
  useEffect(() => setFolded(false), [revealKey]);
  if (revealKey === "") return [open, toggle];
  return [!folded, () => setFolded((value) => !value)];
}

type TreeBuilding = TreeProperty["buildings"][number];
type TreeFloor = TreeBuilding["floors"][number];
type TreeRoom = TreeFloor["rooms"][number];

function includes(value: string | null | undefined, q: string) {
  return q !== "" && !!value && value.toLocaleLowerCase("nb").includes(q);
}

function roomHit(room: TreeRoom, q: string) {
  return includes(room.name, q) || includes(room.number, q);
}

function floorHit(floor: TreeFloor, q: string) {
  return includes(floor.name, q) || floor.rooms.some((room) => roomHit(room, q));
}

function buildingDeep(building: TreeBuilding, q: string) {
  return building.floors.some((floor) => floorHit(floor, q));
}

function pathHas(pathname: string, kind: string, id: string) {
  return pathname.includes(`/${kind}/${id}`);
}

function floorPinned(floor: TreeFloor, pathname: string) {
  return pathHas(pathname, "floors", floor.id) || floor.rooms.some((room) => pathHas(pathname, "rooms", room.id));
}

function buildingPinned(building: TreeBuilding, pathname: string) {
  return pathHas(pathname, "buildings", building.id) || building.floors.some((floor) => floorPinned(floor, pathname));
}

function propertyPinned(property: TreeProperty, pathname: string) {
  return pathHas(pathname, "properties", property.id) || property.buildings.some((building) => buildingPinned(building, pathname));
}

function filterPortfolio(tree: TreeProperty[], q: string): TreeProperty[] {
  const out: TreeProperty[] = [];
  for (const property of tree) {
    if (includes(property.name, q) || includes(property.city, q)) {
      out.push(property);
      continue;
    }
    const buildings = property.buildings.filter((building) => includes(building.name, q) || buildingDeep(building, q));
    if (buildings.length) out.push({ ...property, buildings });
  }
  return out;
}

function portfolioCount(properties: number, buildings: number) {
  const estates = properties === 1 ? "1 eiendom" : `${properties.toLocaleString("nb-NO")} eiendommer`;
  const blocks = buildings === 1 ? "1 bygg" : `${buildings.toLocaleString("nb-NO")} bygg`;
  return `${estates} · ${blocks}`;
}

function Portfolio({
  tree,
  canAdd,
  limited,
  onNewProperty,
  base,
}: {
  tree: TreeProperty[] | undefined;
  canAdd: boolean;
  limited: boolean;
  onNewProperty: () => void;
  base: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const scroller = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase("nb");
  const properties = tree ?? [];
  const buildingCount = useMemo(() => properties.reduce((sum, property) => sum + property.buildings.length, 0), [properties]);
  const many = properties.length > 4 || buildingCount > 8;
  const fallbackOpen = properties.length <= 4;
  const visible = useMemo(() => (q ? filterPortfolio(properties, q) : properties), [properties, q]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const parent = scroller.current;
      const el = parent?.querySelector<HTMLElement>("[data-current='true']");
      if (!parent || !el) return;
      const top = el.getBoundingClientRect().top - parent.getBoundingClientRect().top;
      if (top < 0 || top > parent.clientHeight - el.clientHeight) parent.scrollTop += top - 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, visible]);

  return (
    <>
      <div className="mt-3 flex items-center justify-between gap-2 px-5 pb-1">
        <div className="min-w-0">
          <div className="text-[11.5px] font-semibold tracking-wide text-nav-muted uppercase">Portefølje</div>
          {many && tree && <div className="text-[11px] text-nav-muted">{portfolioCount(properties.length, buildingCount)}</div>}
        </div>
        {canAdd && (
          <Menu
            align="end"
            trigger={() => (
              <IconButton label="Legg til" className="text-nav-muted hover:bg-nav-hover hover:text-nav-ink">
                <Plus className="size-3.5" />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<MapPin className="size-4" />}
                  onClick={() => {
                    close();
                    onNewProperty();
                  }}
                >
                  Ny eiendom
                </MenuItem>
                <MenuItem
                  icon={<FolderTree className="size-4" />}
                  onClick={() => {
                    close();
                    navigate(`${base}/boligmappa`);
                  }}
                >
                  Hent fra Boligmappa
                </MenuItem>
                <MenuItem
                  icon={<KeyRound className="size-4" />}
                  onClick={() => {
                    close();
                    navigate(`${base}/laft`);
                  }}
                >
                  Hent fra LAFT
                </MenuItem>
              </>
            )}
          </Menu>
        )}
      </div>
      {many && (
        <div className="relative px-2.5 pb-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrer eiendommer og bygg …"
            aria-label="Filtrer eiendommer og bygg"
            className="h-7 w-full rounded-md border border-nav-line bg-nav-field px-2 pr-7 text-[12.5px] text-nav-ink outline-none placeholder:text-nav-muted"
          />
          {query && (
            <button type="button" aria-label="Tøm filter" onClick={() => setQuery("")} className="absolute top-0 right-3 flex h-7 items-center text-nav-muted hover:text-nav-ink">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <div ref={scroller} className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        {tree && tree.length === 0 && (
          <div className="px-2.5 py-2 text-[12.5px] text-nav-muted">
            {limited ? "Du har ikke fått tilgang til noen eiendommer ennå." : "Ingen eiendommer ennå. Hent fra Boligmappa eller LAFT, eller opprett selv."}
          </div>
        )}
        {tree && tree.length > 0 && visible.length === 0 && <div className="px-2.5 py-2 text-[12.5px] text-nav-muted">Ingen treff i porteføljen</div>}
        {visible.map((property) => (
          <PropertyNode key={property.id} property={property} fallbackOpen={fallbackOpen} q={q} />
        ))}
      </div>
    </>
  );
}

function TreeRow({
  to,
  icon,
  label,
  depth,
  expandable,
  open,
  onToggle,
  sub,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  depth: number;
  expandable: boolean;
  open?: boolean;
  onToggle?: () => void;
  sub?: string | null;
}) {
  const location = useLocation();
  const active = location.pathname === to || location.pathname.startsWith(to + "/");
  return (
    <div
      data-current={active ? "true" : undefined}
      className={cn(
        "group flex h-7.5 items-center rounded-md text-[13px]",
        active ? "bg-nav-active font-medium text-nav-ink" : "text-nav-ink-2 hover:bg-nav-hover",
      )}
      style={{ paddingLeft: depth * 12 }}
    >
      <button
        onClick={onToggle}
        className={cn("flex size-5 shrink-0 items-center justify-center rounded text-nav-muted hover:text-nav-ink", !expandable && "invisible")}
        aria-label={open ? "Skjul" : "Vis"}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <NavLink to={to} className="flex min-w-0 flex-1 items-center gap-2 pr-2">
        <span className="shrink-0 text-nav-muted [&>svg]:size-3.5">{icon}</span>
        <span className="truncate" title={label}>
          {label}
        </span>
        {sub && <span className="ml-auto shrink-0 text-[11px] text-nav-muted">{sub}</span>}
      </NavLink>
    </div>
  );
}

function PropertyNode({ property, fallbackOpen, q }: { property: TreeProperty; fallbackOpen: boolean; q: string }) {
  const { orgId } = useOrg();
  const { pathname } = useLocation();
  const [open, toggle] = useShown(property.id, fallbackOpen, propertyPinned(property, pathname), pathname, q);
  return (
    <div>
      <TreeRow
        to={`/o/${orgId}/properties/${property.id}`}
        icon={property.has_image ? <img src={placeImageUrl(orgId, "properties", property.id, property.updated_at)} alt="" className="size-4 rounded-[4px] object-cover" /> : <MapPin />}
        label={property.name}
        depth={0}
        expandable={property.buildings.length > 0}
        open={open}
        onToggle={toggle}
        sub={!open && property.buildings.length ? `${property.buildings.length} bygg` : null}
      />
      {open && property.buildings.map((building) => <BuildingNode key={building.id} building={building} q={q} />)}
    </div>
  );
}

function BuildingNode({ building, q }: { building: TreeBuilding; q: string }) {
  const { orgId } = useOrg();
  const { pathname } = useLocation();
  const nameHit = includes(building.name, q);
  const floors = useMemo(() => {
    const sorted = [...building.floors].sort((a, b) => b.level - a.level);
    if (q === "" || nameHit) return sorted;
    return sorted.filter((floor) => floorHit(floor, q));
  }, [building.floors, nameHit, q]);
  const [open, toggle] = useShown(building.id, false, buildingPinned(building, pathname), pathname, q !== "" && !nameHit && floors.length > 0 ? q : "");
  return (
    <div>
      <TreeRow
        to={`/o/${orgId}/buildings/${building.id}`}
        icon={building.has_image ? <img src={placeImageUrl(orgId, "buildings", building.id, building.updated_at)} alt="" className="size-4 rounded-[4px] object-cover" /> : <Building2 />}
        label={building.name}
        depth={1}
        expandable={floors.length > 0}
        open={open}
        onToggle={toggle}
      />
      {open && floors.map((floor) => <FloorNode key={floor.id} floor={floor} q={q} />)}
    </div>
  );
}

function FloorNode({ floor, q }: { floor: TreeFloor; q: string }) {
  const { orgId } = useOrg();
  const { pathname } = useLocation();
  const nameHit = includes(floor.name, q);
  const rooms = q === "" || nameHit ? floor.rooms : floor.rooms.filter((room) => roomHit(room, q));
  const [open, toggle] = useShown(floor.id, false, floorPinned(floor, pathname), pathname, q !== "" && !nameHit && rooms.length > 0 ? q : "");
  return (
    <div>
      <TreeRow
        to={`/o/${orgId}/floors/${floor.id}`}
        icon={<Layers />}
        label={floor.name}
        depth={2}
        expandable={rooms.length > 0}
        open={open}
        onToggle={toggle}
        sub={!open && floor.rooms.length ? String(floor.rooms.length) : null}
      />
      {open &&
        rooms.map((room) => (
          <TreeRow key={room.id} to={`/o/${orgId}/rooms/${room.id}`} icon={<DoorOpen />} label={room.number ? `${room.number} ${room.name}` : room.name} depth={3} expandable={false} />
        ))}
    </div>
  );
}
