// Delte typer mellom Worker (API) og React-appen.

export type Role = "owner" | "admin" | "member";

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface OrgSummary {
  id: string;
  name: string;
  role: Role;
}

export interface Me {
  user: User;
  orgs: OrgSummary[];
}

// ─── Portefølje ───────────────────────────────────────────────────────────────

export interface Property {
  id: string;
  name: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  municipality: string | null;
  gnr: string | null;
  bnr: string | null;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface Building {
  id: string;
  property_id: string;
  name: string;
  building_number: string | null;
  building_type: string | null;
  year_built: number | null;
  gross_area: number | null;
  description: string | null;
  ifc_guid: string | null;
  created_at: number;
  updated_at: number;
}

export interface Floor {
  id: string;
  building_id: string;
  name: string;
  level: number;
  elevation: number | null;
  gross_area: number | null;
  ifc_guid: string | null;
}

export interface Room {
  id: string;
  building_id: string;
  floor_id: string;
  name: string;
  number: string | null;
  usage: string | null;
  area: number | null;
  ifc_guid: string | null;
}

/** Kompakt tre for sidepanelet */
export interface TreeRoom {
  id: string;
  name: string;
  number: string | null;
}
export interface TreeFloor {
  id: string;
  name: string;
  level: number;
  rooms: TreeRoom[];
}
export interface TreeBuilding {
  id: string;
  name: string;
  floors: TreeFloor[];
}
export interface TreeProperty {
  id: string;
  name: string;
  city: string | null;
  buildings: TreeBuilding[];
}

// ─── Komponenter ─────────────────────────────────────────────────────────────

export interface Component {
  id: string;
  building_id: string | null;
  floor_id: string | null;
  room_id: string | null;
  name: string;
  ns3451: string | null;
  tfm: string | null;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  supplier: string | null;
  installed_at: string | null;
  warranty_until: string | null;
  service_interval_months: number | null;
  last_service_at: string | null;
  next_service_at: string | null;
  condition: string | null;
  ifc_guid: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  // utvidet ved listing
  building_name?: string | null;
  floor_name?: string | null;
  room_name?: string | null;
}

// ─── Dokumenter ──────────────────────────────────────────────────────────────

export const DOCUMENT_KINDS = {
  fdv: "FDV-dokumentasjon",
  produktdatablad: "Produktdatablad",
  brukermanual: "Bruks- og vedlikeholdsanvisning",
  tegning: "Tegning",
  ifc: "IFC-modell (BIM)",
  sertifikat: "Sertifikat / samsvarserklæring",
  rapport: "Rapport / tilstandsanalyse",
  kontroll: "Kontroll / servicerapport",
  avtale: "Avtale / kontrakt",
  bilde: "Bilde",
  annet: "Annet",
} as const;
export type DocumentKind = keyof typeof DOCUMENT_KINDS;

export type DocumentStatus = "processing" | "ready" | "error" | "stored";

export interface Document {
  id: string;
  property_id: string | null;
  building_id: string | null;
  floor_id: string | null;
  room_id: string | null;
  component_id: string | null;
  title: string;
  filename: string;
  mime: string;
  size: number;
  kind: DocumentKind;
  ns3451: string | null;
  status: DocumentStatus;
  error: string | null;
  summary: string | null;
  text_chars: number | null;
  uploaded_by: string | null;
  created_at: number;
  updated_at: number;
  // utvidet ved listing
  building_name?: string | null;
  property_name?: string | null;
}

export interface SearchHit {
  document_id: string;
  title: string;
  kind: DocumentKind;
  snippet: string;
  building_id: string | null;
  building_name: string | null;
}

// ─── Oppgaver ────────────────────────────────────────────────────────────────

export type TaskType = "vedlikehold" | "avvik" | "kontroll" | "dokumentasjon" | "annet";
export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "critical";

export const TASK_TYPES: Record<TaskType, string> = {
  vedlikehold: "Vedlikehold",
  avvik: "Avvik",
  kontroll: "Kontroll",
  dokumentasjon: "Dokumentasjon",
  annet: "Annet",
};
export const TASK_STATUSES: Record<TaskStatus, string> = {
  open: "Åpen",
  in_progress: "Pågår",
  done: "Utført",
  cancelled: "Avbrutt",
};
export const TASK_PRIORITIES: Record<TaskPriority, string> = {
  low: "Lav",
  normal: "Normal",
  high: "Høy",
  critical: "Kritisk",
};

export interface Task {
  id: string;
  property_id: string | null;
  building_id: string | null;
  floor_id: string | null;
  room_id: string | null;
  component_id: string | null;
  title: string;
  description: string | null;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  assignee: string | null;
  created_by_user: string | null;
  created_by_agent: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  building_name?: string | null;
  component_name?: string | null;
  agent_name?: string | null;
}

// ─── Agenter ─────────────────────────────────────────────────────────────────

export type ToolGroup =
  | "documents"
  | "documents_write"
  | "portfolio"
  | "portfolio_write"
  | "components"
  | "components_write"
  | "tasks"
  | "artifacts"
  | "ifc"
  | "email"
  | "web";

export const TOOL_GROUPS: Record<ToolGroup, { label: string; description: string; write?: boolean }> = {
  documents: { label: "Les dokumenter", description: "Søke i og lese opplastede dokumenter" },
  documents_write: { label: "Klassifisere dokumenter", description: "Endre tittel, type, NS 3451-kode og plassering på dokumenter", write: true },
  portfolio: { label: "Les portefølje", description: "Se eiendommer, bygg, etasjer og rom" },
  portfolio_write: { label: "Endre portefølje", description: "Opprette og endre bygg, etasjer og rom", write: true },
  components: { label: "Les FDV-register", description: "Se komponenter, serviceintervaller og tilstand" },
  components_write: { label: "Endre FDV-register", description: "Opprette og oppdatere komponenter", write: true },
  tasks: { label: "Oppgaver og avvik", description: "Se, opprette og oppdatere oppgaver, avvik og kontroller", write: true },
  artifacts: { label: "Lage sider (artifacts)", description: "Bygge interaktive sider og dashboards", write: true },
  ifc: { label: "BIM / IFC", description: "Spørre mot elementer i IFC-modeller" },
  email: { label: "Sende e-post", description: "Sende e-post til medlemmer og varslingsmottakere", write: true },
  web: { label: "Nettsøk", description: "Søke på nettet etter produktinfo, forskrifter m.m." },
};

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Balansert – anbefalt" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Kraftigst for krevende analyser" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Raskest og billigst" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "Dyp resonnering – dyrest" },
] as const;

export type Effort = "low" | "medium" | "high";

export interface Agent {
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string | null;
  instructions: string;
  model: string;
  effort: Effort;
  tools: ToolGroup[];
  scope_type: "org" | "property" | "building";
  scope_id: string | null;
  schedule: string | null;
  schedule_prompt: string | null;
  notify_emails: string[];
  next_run_at: number | null;
  last_run_at: number | null;
  template: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentTemplate {
  key: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  instructions: string;
  tools: ToolGroup[];
  effort: Effort;
  schedule?: string;
  schedule_prompt?: string;
}

export interface AgentRun {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  trigger: "schedule" | "manual";
  status: "running" | "done" | "error";
  summary: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

// ─── Samtaler ────────────────────────────────────────────────────────────────

/** Hva brukeren ser på i arbeidsflaten – sendes med hver melding */
export interface FocusContext {
  type: "org" | "property" | "building" | "floor" | "room" | "document" | "component" | "task" | "artifact";
  id?: string;
  label?: string;
}

export interface Conversation {
  id: string;
  agent_id: string;
  title: string | null;
  model: string;
  source: "chat" | "schedule";
  created_at: number;
  updated_at: number;
  agent_name?: string;
  agent_icon?: string;
  agent_color?: string;
}

/** Claude API content blocks (forenklet) */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: "server_tool_use"; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  context: FocusContext | null;
  created_at: number;
}

/** Hendelser som strømmes fra /messages (SSE) */
export type ChatEvent =
  | { type: "message_start"; message_id: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; label: string }
  | { type: "tool_input"; id: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; link?: EntityLink }
  | { type: "message_done"; message_id: string }
  | { type: "title"; title: string }
  | { type: "error"; error: string }
  | { type: "done" };

export interface EntityLink {
  type: "document" | "task" | "component" | "artifact" | "building" | "property" | "floor" | "room";
  id: string;
  label: string;
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

export interface Artifact {
  id: string;
  title: string;
  description: string | null;
  property_id: string | null;
  building_id: string | null;
  current_version: number;
  pinned: number;
  created_by_user: string | null;
  created_by_agent: string | null;
  conversation_id: string | null;
  created_at: number;
  updated_at: number;
  building_name?: string | null;
}

export interface ArtifactVersion {
  version: number;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

// ─── IFC ─────────────────────────────────────────────────────────────────────

export interface IfcImportPayload {
  document_id: string;
  schema: string;
  storeys: { guid: string; name: string; elevation: number | null; spaces: { guid: string; name: string; long_name: string | null; area: number | null }[] }[];
  elements: { express_id: number; guid: string | null; ifc_type: string; name: string | null; storey: string | null; props?: Record<string, unknown> }[];
  create_locations: boolean;
}

export interface IfcSummary {
  document_id: string;
  schema: string | null;
  stats: { by_type: Record<string, number>; by_storey: Record<string, number> } | null;
  indexed_at: number;
}

// ─── Aktivitet / oversikt ────────────────────────────────────────────────────

export interface ActivityItem {
  id: string;
  actor_type: "user" | "agent" | "system";
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  created_at: number;
}

export interface OrgOverview {
  counts: { properties: number; buildings: number; documents: number; components: number; open_tasks: number; agents: number; artifacts: number };
  upcoming_tasks: Task[];
  service_due: Component[];
  recent_documents: Document[];
  activity: ActivityItem[];
}

export interface Member {
  user_id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: number;
}
