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
  /** false = lesetilgang */
  can_edit: boolean;
  /** true = bare utvalgte eiendommer/bygg */
  limited: boolean;
  /** Siste dag med tilgang (YYYY-MM-DD), eller null */
  expires_on: string | null;
}

export interface Me {
  user: User;
  orgs: OrgSummary[];
  platformAdmin?: boolean;
}

export type BillingStatus = "none" | "demo" | "active" | "past_due" | "canceled";

export type PlanId = "standard" | "pro";

/** Beløp er i kroner inkl. mva. includedAiNok er AI-bruken som følger med hver måned. */
export interface Plan {
  id: PlanId;
  name: string;
  priceNok: number;
  includedAiNok: number;
  buildings: number;
  blurb: string;
}

export const PLANS: Record<PlanId, Plan> = {
  standard: { id: "standard", name: "Standard", priceNok: 990, includedAiNok: 300, buildings: 10, blurb: "For forvaltere som vil i gang med noen få bygg." },
  pro: { id: "pro", name: "Pro", priceNok: 3000, includedAiNok: 1200, buildings: 50, blurb: "For porteføljer der agentene jobber hver dag." },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export function planOf(id: string | null | undefined): Plan {
  return PLANS[id as PlanId] ?? PLANS.standard;
}

export interface BillingInfo {
  status: BillingStatus;
  plan: PlanId;
  /** Abonnementet er gitt uten Stripe (avtalt med LAFT). AI-bruk faktureres ikke. */
  managed: boolean;
  /** Kunden finnes i Stripe, så betalingsportalen kan åpnes */
  portal: boolean;
  /** Effektiv byggkvote: planens bygg, eller høyere hvis den er avtalt */
  building_limit: number;
  building_count: number;
  stripe_ready: boolean;
  /** Planer som har pris i Stripe og kan velges */
  plans_available: PlanId[];
  note: string | null;
  /** Øvre grense for ekstra bruk per måned, i øre inkl. mva. null = ubegrenset. */
  spend_limit_ore: number | null;
  /** Når inkludert bruk nullstilles (starten av neste måned) */
  resets_at: number;
  usage: UsageMonth;
}

/** AI-bruk per dag denne måneden, i øre inkl. mva, fordelt på hva som brukte den */
export interface UsageDay {
  day: string;
  chat: number;
  schedule: number;
  document: number;
}

/** Forhåndskjøpte AI-kreditter. creditNok er bruken man får, priceNok er det man betaler. Begge inkl. mva. */
export interface CreditPack {
  id: string;
  creditNok: number;
  priceNok: number;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: "1000", creditNok: 1000, priceNok: 1000 },
  { id: "3000", creditNok: 3000, priceNok: 2700 },
  { id: "10000", creditNok: 10000, priceNok: 8500 },
];

export function creditPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/**
 * AI-bruk denne måneden. billedOre er målt bruk inkl. mva. invoiceOre er det som går over inkludert
 * bruk og kreditter, begrenset av månedsgrensen. paused betyr at grensen er nådd og AI er stoppet.
 */
export interface UsageMonth {
  costOre: number;
  billedOre: number;
  includedOre: number;
  invoiceOre: number;
  /** Bruk utover inkludert og kreditter, før grensen. Det er dette grensen måles mot. */
  extraOre: number;
  /** Trukket fra kredittene denne måneden */
  creditUsedOre: number;
  limitOre: number | null;
  paused: boolean;
  pendingOre: number;
  trialOre: number;
  markupPercent: number;
  /** Ubrukte kreditter som fortsatt er gyldige. */
  creditOre: number;
  /** Tidligste utløp blant kredittene som er igjen. */
  creditExpiresAt: number | null;
}

/** Lett status for «neste steg». Holder onboarding i gang til portefølje, spørsmål og betaling er gjort. */
export interface Activation {
  properties: number;
  /** Første eiendom, brukes når byggene mangler og neste steg er å legge inn et bygg der. */
  firstPropertyId: string | null;
  buildings: number;
  documents: number;
  talked: boolean;
  serviceOverdue: number;
  /** Eldste komponent med service på overtid. Brukes når det bare er én. */
  serviceComponentId: string | null;
  billing: BillingStatus;
  stripeReady: boolean;
  /** Prøvebruk denne måneden, inkl. mva. Faktureres ikke. */
  monthUsageOre: number;
  /** Beløp inkl. mva som ligger til neste faktura. Prøvebruk er ikke med. */
  monthInvoiceOre: number;
  boligmappa: {
    configured: boolean;
    connected: boolean;
    status: string;
    cachedBuildings: number;
    pendingImport: number;
  };
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
  has_image: boolean;
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
  has_image: boolean;
  /** «vert:id» når bygget er hentet fra LAFT */
  laft_ref?: string | null;
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
  has_image: boolean;
  updated_at: number;
  floors: TreeFloor[];
}
export interface TreeProperty {
  id: string;
  name: string;
  city: string | null;
  has_image: boolean;
  updated_at: number;
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
  | "web"
  | "laft"
  | "laft_import"
  | "laft_write"
  | "boligmappa";

export const TOOL_GROUPS: Record<ToolGroup, { label: string; description: string; write?: boolean }> = {
  documents: { label: "Les dokumenter", description: "Søke i og lese opplastede dokumenter" },
  documents_write: { label: "Klassifisere dokumenter", description: "Endre tittel, type, NS 3451-kode og plassering på dokumenter", write: true },
  portfolio: { label: "Les portefølje", description: "Se eiendommer, bygg, etasjer og rom" },
  portfolio_write: { label: "Endre portefølje", description: "Opprette og endre bygg, etasjer og rom", write: true },
  components: { label: "Les FDV-register", description: "Se komponenter, serviceintervaller og tilstand" },
  components_write: { label: "Endre FDV-register", description: "Opprette og oppdatere komponenter", write: true },
  tasks: { label: "Oppgaver og avvik", description: "Se, opprette og oppdatere oppgaver, avvik og kontroller", write: true },
  artifacts: { label: "Lage sider (artifacts)", description: "Bygge interaktive sider og dashboards, og feste dem i sidemenyen", write: true },
  ifc: { label: "BIM / IFC", description: "Spørre mot elementer i IFC-modeller" },
  email: { label: "Sende e-post", description: "Sende e-post til medlemmer og varslingsmottakere", write: true },
  web: { label: "Nettsøk", description: "Søke på nettet etter produktinfo, forskrifter m.m." },
  laft: { label: "Les LAFT", description: "Bygg, arbeidsordrer, rutiner, dokumentarkiv og alt annet i LAFT – med tilgangen til den som koblet til" },
  laft_import: { label: "Hente fra LAFT", description: "Ta bygg, etasjer, rom og dokumenter fra LAFT inn i Plank", write: true },
  laft_write: { label: "Endre i LAFT", description: "Opprette, kommentere og oppdatere arbeidsordrer i LAFT", write: true },
  boligmappa: { label: "Boligmappa", description: "Søke i Boligmappa og hente bygg og dokumenter inn i Plank", write: true },
};

/** Grupper som bare gir mening når organisasjonen har koblet til tjenesten */
export const LAFT_TOOL_GROUPS: ToolGroup[] = ["laft", "laft_import", "laft_write"];

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
  sidebar_order: number | null;
  sidebar_icon: string | null;
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

/** Ikoner sider kan ha i sidemenyen */
export const SIDEBAR_ICONS = [
  "dashboard",
  "chart",
  "calendar",
  "checklist",
  "wrench",
  "flame",
  "shield",
  "building",
  "map",
  "file",
  "gauge",
  "bell",
  "zap",
  "droplet",
  "thermometer",
  "leaf",
  "users",
  "table",
  "star",
  "clipboard",
] as const;
export type SidebarIcon = (typeof SIDEBAR_ICONS)[number];

export interface SidebarPage {
  id: string;
  title: string;
  sidebar_icon: string | null;
  sidebar_order: number;
}

// ─── LAFT ────────────────────────────────────────────────────────────────────

export interface LaftInstanceOption {
  name: string;
  url: string;
  host: string;
  mfa: boolean;
  test: boolean;
}

export interface LaftAccountInfo {
  id: string;
  serverName: string;
  serverUrl: string;
  host: string;
  name: string | null;
  email: string;
  role: string | null;
  areaName: string | null;
  status: "ok" | "expired";
  error: string | null;
  refreshedAt: number | null;
}

export interface LaftStatus {
  configured: boolean;
  account: (LaftAccountInfo & { connectedBy: string | null; mine: boolean }) | null;
  /** LAFT-kontoer brukeren har logget inn med, som kan kobles til denne organisasjonen */
  available: LaftAccountInfo[];
  agents: { total: number; read: number; write: number };
  imported: { buildings: number; documents: number };
}

export interface LaftBuilding {
  id: string;
  name: string;
  address: string | null;
  zip: string | null;
  city: string | null;
  type: string | null;
  lat: number | null;
  lon: number | null;
  floors: number;
  rooms: number;
  imageUrl: string | null;
  plankBuildingId: string | null;
}

export interface LaftWorkOrder {
  id: number;
  title: string;
  location: string | null;
  deadline: string | null;
  pastDue: string | null;
  isRoutine: boolean;
  isPastDueRoutine: boolean;
  createdAt: string | null;
  state: { id: number; name: string } | null;
  priority: number | null;
  building: { id: string; name: string } | null;
  place: string | null;
  responsible: string[];
  createdBy: string | null;
  comments: number;
  hasImages: boolean;
  hasDocuments: boolean;
  url: string;
}

export interface LaftWorkOrderList {
  total: number;
  hasMore: boolean;
  cursor: string | null;
  items: LaftWorkOrder[];
}

export interface LaftDocumentNode {
  id: number;
  name: string;
  isFolder: boolean;
  childrenCount: number;
  fileCount: number;
  contentType: string | null;
  size: string | null;
  createdAt: string | null;
  plankDocumentId: string | null;
}

export interface LaftDashboard {
  pastDue: number;
  pastDueRoutines: number;
  dueThisWeek: number;
  performedThisWeek: number;
  unassigned: number;
}

export interface BmUnit {
  bmn: string;
  name: string;
  documentCount: number;
}

export interface BmBuilding {
  bmn: string;
  name: string;
  buildingNumber: string | null;
  buildingType: string | null;
  area: number | null;
  yearBuilt: number | null;
  documentCount: number;
  importedBuildingId: string | null;
  units: BmUnit[];
}

export interface BmEstate {
  key: string;
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  municipality: string | null;
  gnr: string | null;
  bnr: string | null;
  importedPropertyId: string | null;
  buildings: BmBuilding[];
  documents: number;
}

export interface BmTree {
  configured: boolean;
  orgNr: string | null;
  status: string;
  phase: string;
  page: number;
  buildingCount: number;
  unitCount: number;
  documentCount: number;
  error: string | null;
  updatedAt: number | null;
  estates: BmEstate[];
  agents: { total: number; withTool: number };
  imported: { properties: number; buildings: number; documents: number };
}

export interface BmDocument {
  remoteId: string;
  title: string;
  filename: string | null;
  category: string | null;
  ownerKind: string;
  ownerBmn: string;
  ownerName: string | null;
  importedDocumentId: string | null;
  error: string | null;
}

/** Ett steg i automatisk henting fra Boligmappa (trakten for nye Næringsmappa-kunder) */
export interface AutoImportStep {
  stage: "off" | "sync" | "import" | "error" | "done";
  phase: string;
  buildingCount: number;
  documentCount: number;
  importedBuildings: number;
  importedDocuments: number;
  remainingDocuments: number | null;
  message: string | null;
  waited: boolean;
  /** Når Boligmappa har feilet: hvor lenge det er til neste forsøk */
  retryInMs: number | null;
}

export interface LaftImportStep {
  processed: number;
  createdProperties: number;
  createdBuildings: number;
  updatedBuildings: number;
  createdFloors: number;
  createdRooms: number;
  remaining: string[];
  message: string | null;
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

export interface MemberPlace {
  type: "property" | "building";
  id: string;
  name: string;
  /** For bygg: eiendommen bygget ligger på */
  property_name: string | null;
}

export interface Member {
  user_id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: number;
  can_edit: boolean;
  scope: "all" | "limited";
  /** Eiendommer og bygg ved begrenset tilgang (bare synlig for administratorer) */
  places: MemberPlace[];
  /** Siste dag med tilgang (YYYY-MM-DD) */
  expires_on: string | null;
  expired: boolean;
  invited_by: string | null;
}

export interface MemberAccessInput {
  role: Role;
  can_edit: boolean;
  scope: "all" | "limited";
  property_ids: string[];
  building_ids: string[];
  expires_on: string | null;
}

// ─── API og MCP ──────────────────────────────────────────────────────────────

export interface ApiKeySummary {
  id: string;
  name: string;
  /** key = laget i innstillingene, oauth = gitt til en MCP-klient (f.eks. Claude) */
  kind: "key" | "oauth";
  prefix: string;
  can_write: boolean;
  user_id: string;
  user_email: string;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
}
