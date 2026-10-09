import { useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Building2,
  ChevronRight,
  ChevronsUpDown,
  DoorOpen,
  FileText,
  House,
  Layers,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu as MenuIcon,
  Monitor,
  Moon,
  PanelRightOpen,
  Plus,
  Search,
  Settings,
  SquareCheck,
  Sun,
  Wrench,
} from "lucide-react";
import type { TreeProperty } from "@shared/types";
import { AgentPanelProvider, FocusProvider, OrgProvider, useAgentPanel, useMe, useOrg, useOrgQuery, useTheme } from "@/lib/app";
import { api } from "@/lib/api";
import { Logo } from "./domain";
import { cn, IconButton, Loading, Menu, MenuItem } from "./ui";
import { AgentPanel } from "@/features/chat/AgentPanel";
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
    <OrgProvider value={{ orgId: org.id, org, me: me.data, isAdmin: org.role !== "member" }}>
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
        <div className="@container min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>

      {/* Agentpanel */}
      <AgentPanel />
      {!panel.open && (
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
  );
}

function NavItem({ to, icon, label, end }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors",
          isActive ? "bg-panel-2 font-medium text-ink" : "text-ink-2 hover:bg-panel-2/70 hover:text-ink",
        )
      }
    >
      <span className="text-muted [&>svg]:size-4">{icon}</span>
      {label}
    </NavLink>
  );
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { orgId, org, me } = useOrg();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const panel = useAgentPanel();
  const tree = useOrgQuery<TreeProperty[]>("/portfolio/tree");
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
                <span className="block text-[11.5px] text-muted">Plank</span>
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

      <nav className="mt-3 flex flex-col gap-0.5 px-2.5">
        <NavItem to={base} end icon={<House />} label="Oversikt" />
        <NavItem to={`${base}/tasks`} icon={<SquareCheck />} label="Oppgaver" />
        <NavItem to={`${base}/documents`} icon={<FileText />} label="Dokumenter" />
        <NavItem to={`${base}/components`} icon={<Wrench />} label="FDV-register" />
        <NavItem to={`${base}/artifacts`} icon={<LayoutDashboard />} label="Sider" />
        <NavItem to={`${base}/agents`} icon={<Bot />} label="Agenter" />
      </nav>

      <div className="mt-5 flex items-center justify-between px-5 pb-1">
        <span className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Portefølje</span>
        <IconButton label="Ny eiendom" size="sm" onClick={() => setNewProperty(true)}>
          <Plus className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {tree.data && tree.data.length === 0 && <div className="px-2.5 py-2 text-[12.5px] text-muted">Ingen eiendommer ennå.</div>}
        {tree.data?.map((p) => <PropertyNode key={p.id} property={p} />)}
      </div>

      {/* Bruker */}
      <div className="border-t border-line p-2.5">
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
        <span className="truncate">{label}</span>
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
      <TreeRow to={`/o/${orgId}/properties/${property.id}`} icon={<MapPin />} label={property.name} depth={0} expandable={property.buildings.length > 0} open={open} onToggle={toggle} />
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
      <TreeRow to={`/o/${orgId}/buildings/${building.id}`} icon={<Building2 />} label={building.name} depth={1} expandable={floors.length > 0} open={open} onToggle={toggle} />
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
