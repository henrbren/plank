import { useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
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
  Users,
  Wrench,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SidebarPage, TreeProperty } from "@shared/types";
import { placeImageUrl } from "@/features/places/PlacePhoto";
import { UsageMeter } from "@/features/billing/UsageMeter";
import { BackgroundImport } from "@/features/onboarding/Funnel";
import { useBrand } from "@/lib/brand";
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
  const location = useLocation();
  const onArtifact = /\/artifacts\/[^/]+$/.test(location.pathname);

  useEffect(() => setNavOpen(false), [location.pathname]);

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
          "fixed inset-y-0 left-0 z-40 w-[264px] shrink-0 border-r border-line bg-panel transition-transform lg:static lg:translate-x-0",
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

function NavItem({ to, icon, label, end }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cn(
          "flex h-8 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors",
          isActive ? "bg-panel-2 font-medium text-ink" : "text-ink-2 hover:bg-panel-2/70 hover:text-ink",
        )
      }
    >
      <span className="shrink-0 text-muted [&>svg]:size-4">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </NavLink>
  );
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { orgId, org, me, isAdmin, canEdit, limited } = useOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const panel = useAgentPanel();
  const openGuide = useOpenGuide();
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");
  const brand = useBrand();
  const [newProperty, setNewProperty] = useState(false);
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
            <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2">
              <Logo withText={false} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{org.name}</span>
                <span className="block text-[11.5px] text-muted">{brand.name}</span>
              </span>
              <ChevronsUpDown className="size-4 text-muted" />
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
        <button onClick={onSearch} className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-bg px-2.5 text-[13px] text-muted hover:border-line-strong">
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Søk …</span>
          <kbd className="rounded border border-line px-1 text-[10.5px]">⌘K</kbd>
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

      <nav className="mt-3 flex flex-col gap-0.5 px-2.5">
        <NavItem to={base} end icon={<House />} label="Oversikt" />
        <NavItem to={`${base}/tasks`} icon={<SquareCheck />} label="Oppgaver" />
        <NavItem to={`${base}/documents`} icon={<FileText />} label="Dokumenter" />
        <NavItem to={`${base}/components`} icon={<Wrench />} label="FDV-register" />
        <NavItem to={`${base}/agents`} icon={<Bot />} label="Agenter" />
        <NavItem to={`${base}/artifacts`} icon={<LayoutDashboard />} label="Sider" />
        <NavItem to={`${base}/hjelp`} icon={<CircleHelp />} label="Hjelp" />
        <SidebarPages />
      </nav>

      <div className="mt-5 flex items-center justify-between px-5 pb-1">
        <span className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Portefølje</span>
        {canEdit && !limited && (
        <Menu
          align="end"
          trigger={() => (
            <IconButton label="Legg til">
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
                  setNewProperty(true);
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
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {tree.data && tree.data.length === 0 && (
          <div className="px-2.5 py-2 text-[12.5px] text-muted">
            {limited ? "Du har ikke fått tilgang til noen eiendommer ennå." : "Ingen eiendommer ennå. Hent fra Boligmappa eller LAFT, eller opprett selv."}
          </div>
        )}
        {tree.data?.map((p) => <PropertyNode key={p.id} property={p} />)}
      </div>

      <div className="border-t border-line px-2.5 pt-1.5">
        <BackgroundImport orgId={orgId} />
        <UsageMeter />
      </div>
      {/* Bruker */}
      <div className="p-2.5">
        <Menu
          align="start"
          className="w-full"
          trigger={() => (
            <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent uppercase">
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
    <div className="mt-3 flex flex-col gap-0.5">
      <div className="px-2.5 pb-1 text-[11.5px] font-semibold tracking-wide text-muted uppercase">Mine sider</div>
      {pages.data.map((p) => {
        const Icon = (p.sidebar_icon && PAGE_ICONS[p.sidebar_icon]) || LayoutDashboard;
        return <NavItem key={p.id} to={`/o/${orgId}/artifacts/${p.id}`} icon={<Icon />} label={p.title} />;
      })}
    </div>
  );
}

// ─── Porteføljetre ───────────────────────────────────────────────────────────

function useExpanded(id: string, defaultOpen = false): [boolean, () => void] {
  const key = `plank-tree-${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(key, o ? "0" : "1");
      } catch {
        /* ignorer */
      }
      return !o;
    });
  return [open, toggle];
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
    <div className={cn("group flex h-7.5 items-center rounded-md text-[13px]", active ? "bg-panel-2 font-medium text-ink" : "text-ink-2 hover:bg-panel-2/70")} style={{ paddingLeft: depth * 12 }}>
      <button
        onClick={onToggle}
        className={cn("flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-ink", !expandable && "invisible")}
        aria-label={open ? "Skjul" : "Vis"}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <NavLink to={to} className="flex min-w-0 flex-1 items-center gap-2 pr-2">
        <span className="shrink-0 text-muted [&>svg]:size-3.5">{icon}</span>
        <span className="truncate" title={label}>
          {label}
        </span>
        {sub && <span className="ml-auto shrink-0 text-[11px] text-muted">{sub}</span>}
      </NavLink>
    </div>
  );
}

function PropertyNode({ property }: { property: TreeProperty }) {
  const { orgId } = useOrg();
  const [open, toggle] = useExpanded(property.id, true);
  return (
    <div>
      <TreeRow to={`/o/${orgId}/properties/${property.id}`} icon={property.has_image ? <img src={placeImageUrl(orgId, "properties", property.id, property.updated_at)} alt="" className="size-4 rounded-[4px] object-cover" /> : <MapPin />} label={property.name} depth={0} expandable={property.buildings.length > 0} open={open} onToggle={toggle} />
      {open &&
        property.buildings.map((b) => <BuildingNode key={b.id} building={b} />)}
    </div>
  );
}

function BuildingNode({ building }: { building: TreeProperty["buildings"][number] }) {
  const { orgId } = useOrg();
  const [open, toggle] = useExpanded(building.id);
  const floors = useMemo(() => [...building.floors].sort((a, b) => b.level - a.level), [building.floors]);
  return (
    <div>
      <TreeRow to={`/o/${orgId}/buildings/${building.id}`} icon={building.has_image ? <img src={placeImageUrl(orgId, "buildings", building.id, building.updated_at)} alt="" className="size-4 rounded-[4px] object-cover" /> : <Building2 />} label={building.name} depth={1} expandable={floors.length > 0} open={open} onToggle={toggle} />
      {open && floors.map((f) => <FloorNode key={f.id} floor={f} />)}
    </div>
  );
}

function FloorNode({ floor }: { floor: TreeProperty["buildings"][number]["floors"][number] }) {
  const { orgId } = useOrg();
  const [open, toggle] = useExpanded(floor.id);
  return (
    <div>
      <TreeRow
        to={`/o/${orgId}/floors/${floor.id}`}
        icon={<Layers />}
        label={floor.name}
        depth={2}
        expandable={floor.rooms.length > 0}
        open={open}
        onToggle={toggle}
        sub={floor.rooms.length ? String(floor.rooms.length) : null}
      />
      {open &&
        floor.rooms.map((r) => (
          <TreeRow key={r.id} to={`/o/${orgId}/rooms/${r.id}`} icon={<DoorOpen />} label={r.number ? `${r.number} ${r.name}` : r.name} depth={3} expandable={false} />
        ))}
    </div>
  );
}
