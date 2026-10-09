import { marked } from "marked";
import type { Env, SessionUser } from "../env";
import type { ClaudeTool, ServerTool } from "../lib/anthropic";
import { activityStatement } from "../lib/activity";
import { all, first } from "../lib/db";
import { emailConfigured, emailLayout, sendEmail } from "../lib/email";
import { escapeHtml, parseJson, truncate } from "../lib/util";
import { DOCUMENT_KINDS, type EntityLink, type ToolGroup } from "../../shared/types";
import { componentSchema, createComponent, getComponent, listComponents, updateComponent } from "../services/components";
import { documentPatchSchema, listDocuments, readDocumentText, searchDocuments, updateDocument } from "../services/documents";
import {
  buildingSchema,
  createBuilding,
  createFloor,
  createProperty,
  createRoom,
  floorSchema,
  getBuilding,
  getFloor,
  getProperty,
  getRoom,
  getTree,
  propertySchema,
  roomSchema,
  updateBuilding,
  updateFloor,
  updateProperty,
  updateRoom,
} from "../services/portfolio";
import { createTask, listTasks, taskPatchSchema, taskSchema, updateTask } from "../services/tasks";
import { createArtifact, getArtifactHtml, listArtifacts, saveArtifactVersion } from "../services/artifacts";
import { queryIfcElements } from "../routes/ifc";

export interface AgentRow {
  id: string;
  org_id: string;
  name: string;
  instructions: string;
  model: string;
  effort: string;
  tools: string;
  scope_type: "org" | "property" | "building";
  scope_id: string | null;
  notify_emails: string;
  schedule_prompt: string | null;
}

export interface ToolContext {
  env: Env;
  orgId: string;
  agent: AgentRow;
  conversationId: string;
  user: SessionUser | null;
  scope: { property_id: string | null; building_id: string | null };
}

export interface ToolOutcome {
  /** Det modellen får tilbake */
  content: string;
  /** Kort tekst for brukergrensesnittet */
  summary: string;
  link?: EntityLink;
  isError?: boolean;
}

interface ToolDef {
  group: ToolGroup;
  tool: ClaudeTool;
  label: (input: any) => string;
  run: (ctx: ToolContext, input: any) => Promise<ToolOutcome>;
}

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const idProp = (what: string) => ({ type: "string", description: `ID for ${what}` });

const json = (v: unknown) => JSON.stringify(v, null, 0);

function inDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function logAgent(ctx: ToolContext, action: string, entityType: string, entityId: string, summary: string) {
  try {
    await activityStatement(ctx.env, {
      orgId: ctx.orgId,
      actor: { type: "agent", id: ctx.agent.id, name: ctx.agent.name },
      action,
      entityType,
      entityId,
      summary,
    }).run();
  } catch (err) {
    console.error(err);
  }
}

// ─── Verktøydefinisjoner ─────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  // ── Dokumenter ──
  {
    group: "documents",
    label: (i) => `Søker i dokumenter etter «${truncate(String(i.query ?? ""), 60)}»`,
    tool: {
      name: "search_documents",
      description:
        "Fulltekstsøk i opplastede dokumenter (FDV-dokumentasjon, produktdatablad, rapporter, avtaler m.m.). Returnerer treff med utdrag. Bruk flere korte søkeord heller enn hele setninger. Les deretter relevante dokumenter med read_document.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Søkeord, f.eks. «filterbytte ventilasjon»" },
          building_id: idProp("bygg som søket skal avgrenses til"),
          property_id: idProp("eiendom som søket skal avgrenses til"),
          kind: { type: "string", enum: Object.keys(DOCUMENT_KINDS) },
          limit: { ...int, description: "Maks antall dokumenter (standard 10)" },
        },
        required: ["query"],
      },
    },
    run: async (ctx, i) => {
      const hits = await searchDocuments(ctx.env, ctx.orgId, String(i.query ?? ""), {
        building_id: i.building_id ?? (i.property_id ? null : ctx.scope.building_id),
        property_id: i.property_id ?? (i.building_id ? null : ctx.scope.property_id),
        kind: i.kind,
        limit: i.limit ?? 10,
      });
      return {
        content: hits.length ? json(hits) : "Ingen treff. Prøv andre eller færre søkeord, eller list dokumenter med list_documents.",
        summary: `${hits.length} treff`,
      };
    },
  },
  {
    group: "documents",
    label: () => "Leser dokument",
    tool: {
      name: "read_document",
      description: "Leser uttrukket tekst (markdown) fra et dokument. Lange dokumenter leses i deler – bruk next_offset for å fortsette.",
      input_schema: {
        type: "object",
        properties: { document_id: idProp("dokumentet"), offset: { ...int, description: "Tegnposisjon å starte fra (standard 0)" } },
        required: ["document_id"],
      },
    },
    run: async (ctx, i) => {
      const r = await readDocumentText(ctx.env, ctx.orgId, String(i.document_id), Number(i.offset ?? 0), 15000);
      const d = r.document;
      const header = {
        id: d.id,
        title: d.title,
        filename: d.filename,
        kind: d.kind,
        ns3451: d.ns3451,
        status: d.status,
        building: d.building_name,
        component_id: d.component_id,
        summary: d.summary,
        total_chars: r.total_chars,
        offset: r.offset,
        next_offset: r.next_offset,
      };
      const body = r.text || (d.status === "processing" ? "(Dokumentet behandles fortsatt – prøv igjen om litt.)" : "(Ingen tekst kunne hentes ut fra denne filen.)");
      return {
        content: `${json(header)}\n\n<dokumentinnhold>\n${body}\n</dokumentinnhold>`,
        summary: d.title,
        link: { type: "document", id: d.id, label: d.title },
      };
    },
  },
  {
    group: "documents",
    label: () => "Lister dokumenter",
    tool: {
      name: "list_documents",
      description: "Lister dokumenter med metadata (tittel, type, NS 3451, plassering, sammendrag). Kan filtreres på plassering, komponent og type.",
      input_schema: {
        type: "object",
        properties: {
          building_id: idProp("bygget"),
          property_id: idProp("eiendommen"),
          floor_id: idProp("etasjen"),
          room_id: idProp("rommet"),
          component_id: idProp("komponenten"),
          kind: { type: "string", enum: Object.keys(DOCUMENT_KINDS) },
        },
      },
    },
    run: async (ctx, i) => {
      const hasFilter = i.building_id || i.property_id || i.floor_id || i.room_id || i.component_id;
      const docs = await listDocuments(ctx.env, ctx.orgId, {
        building_id: i.building_id ?? (hasFilter ? null : ctx.scope.building_id),
        property_id: i.property_id ?? (hasFilter ? null : ctx.scope.property_id),
        floor_id: i.floor_id,
        room_id: i.room_id,
        component_id: i.component_id,
        kind: i.kind,
        limit: 200,
      });
      const rows = docs.map((d) => ({
        id: d.id,
        title: d.title,
        kind: d.kind,
        ns3451: d.ns3451,
        status: d.status,
        building: d.building_name,
        building_id: d.building_id,
        component_id: d.component_id,
        summary: d.summary ? truncate(d.summary, 200) : null,
        uploaded: new Date(d.created_at).toISOString().slice(0, 10),
      }));
      return { content: json(rows), summary: `${rows.length} dokumenter` };
    },
  },
  {
    group: "documents_write",
    label: () => "Oppdaterer dokument",
    tool: {
      name: "update_document",
      description: "Endrer metadata for et dokument: tittel, type, NS 3451-kode, sammendrag, plassering (bygg/etasje/rom) og tilknyttet komponent.",
      input_schema: {
        type: "object",
        properties: {
          document_id: idProp("dokumentet"),
          title: str,
          kind: { type: "string", enum: Object.keys(DOCUMENT_KINDS) },
          ns3451: { type: "string", description: "NS 3451-kode, f.eks. 36 eller 360" },
          summary: str,
          building_id: idProp("bygget"),
          floor_id: idProp("etasjen"),
          room_id: idProp("rommet"),
          component_id: idProp("komponenten"),
        },
        required: ["document_id"],
      },
    },
    run: async (ctx, i) => {
      const { document_id, ...patch } = i;
      const parsed = documentPatchSchema.parse(patch);
      const d = await updateDocument(ctx.env, ctx.orgId, String(document_id), parsed);
      await logAgent(ctx, "document.updated", "document", d.id, `Oppdaterte ${d.title}`);
      return { content: json({ ok: true, id: d.id, title: d.title, kind: d.kind, ns3451: d.ns3451 }), summary: d.title, link: { type: "document", id: d.id, label: d.title } };
    },
  },

  // ── Portefølje ──
  {
    group: "portfolio",
    label: () => "Henter porteføljen",
    tool: {
      name: "get_portfolio",
      description: "Henter hele porteføljen som tre: eiendommer → bygg → etasjer (med antall rom). Bruk for å finne ID-er til bygg, etasjer og rom.",
      input_schema: { type: "object", properties: { include_rooms: { type: "boolean", description: "Ta med alle rom (kan bli langt)" } } },
    },
    run: async (ctx, i) => {
      const tree = await getTree(ctx.env, ctx.orgId);
      const filtered = ctx.scope.property_id ? tree.filter((p) => p.id === ctx.scope.property_id) : tree;
      const compact = filtered.map((p) => ({
        property: { id: p.id, name: p.name, city: p.city },
        buildings: p.buildings
          .filter((b) => !ctx.scope.building_id || b.id === ctx.scope.building_id)
          .map((b) => ({
            id: b.id,
            name: b.name,
            floors: b.floors.map((f) => (i.include_rooms ? { id: f.id, name: f.name, level: f.level, rooms: f.rooms } : { id: f.id, name: f.name, level: f.level, room_count: f.rooms.length })),
          })),
      }));
      return { content: json(compact), summary: `${filtered.length} eiendommer` };
    },
  },
  {
    group: "portfolio",
    label: (i) => `Henter ${({ property: "eiendom", building: "bygg", floor: "etasje", room: "rom" } as Record<string, string>)[i.type] ?? "plassering"}`,
    tool: {
      name: "get_location",
      description: "Henter detaljer om en eiendom, et bygg (med etasjer og nøkkeltall), en etasje (med rom) eller et rom.",
      input_schema: {
        type: "object",
        properties: { type: { type: "string", enum: ["property", "building", "floor", "room"] }, id: str },
        required: ["type", "id"],
      },
    },
    run: async (ctx, i) => {
      const id = String(i.id);
      const map = {
        property: () => getProperty(ctx.env, ctx.orgId, id),
        building: () => getBuilding(ctx.env, ctx.orgId, id),
        floor: () => getFloor(ctx.env, ctx.orgId, id),
        room: () => getRoom(ctx.env, ctx.orgId, id),
      } as const;
      const fn = map[i.type as keyof typeof map];
      if (!fn) throw new Error("Ukjent type");
      const data = (await fn()) as { name: string };
      return { content: json(data), summary: data.name, link: { type: i.type, id, label: data.name } };
    },
  },
  {
    group: "portfolio_write",
    label: (i) => `Oppretter ${({ property: "eiendom", building: "bygg", floor: "etasje", room: "rom" } as Record<string, string>)[i.type] ?? ""} «${i.name ?? ""}»`,
    tool: {
      name: "create_location",
      description:
        "Oppretter eiendom, bygg, etasje eller rom. parent_id er eiendom-ID for bygg, bygg-ID for etasje og etasje-ID for rom (ikke nødvendig for eiendom). Etasjenivå (level): -1 = kjeller, 0 = 1. etasje, 1 = 2. etasje osv.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["property", "building", "floor", "room"] },
          parent_id: str,
          name: str,
          fields: {
            type: "object",
            description:
              "Ekstra felter. Eiendom: address, postal_code, city, municipality, gnr, bnr, description. Bygg: building_number, building_type, year_built, gross_area, description. Etasje: level, elevation, gross_area. Rom: number, usage, area.",
          },
        },
        required: ["type", "name"],
      },
    },
    run: async (ctx, i) => {
      const fields = (i.fields ?? {}) as Record<string, unknown>;
      let created: { id: string; name: string };
      if (i.type === "property") created = await createProperty(ctx.env, ctx.orgId, propertySchema.parse({ ...fields, name: i.name }));
      else if (i.type === "building") created = await createBuilding(ctx.env, ctx.orgId, buildingSchema.parse({ ...fields, name: i.name, property_id: i.parent_id }));
      else if (i.type === "floor") created = await createFloor(ctx.env, ctx.orgId, floorSchema.parse({ ...fields, name: i.name, building_id: i.parent_id }));
      else if (i.type === "room") created = await createRoom(ctx.env, ctx.orgId, roomSchema.parse({ ...fields, name: i.name, floor_id: i.parent_id }));
      else throw new Error("Ukjent type");
      await logAgent(ctx, `${i.type}.created`, i.type, created.id, `Opprettet ${created.name}`);
      return { content: json({ ok: true, id: created.id }), summary: created.name, link: { type: i.type, id: created.id, label: created.name } };
    },
  },
  {
    group: "portfolio_write",
    label: () => "Oppdaterer plassering",
    tool: {
      name: "update_location",
      description: "Endrer felter på en eiendom, et bygg, en etasje eller et rom (se create_location for feltnavn).",
      input_schema: {
        type: "object",
        properties: { type: { type: "string", enum: ["property", "building", "floor", "room"] }, id: str, fields: { type: "object" } },
        required: ["type", "id", "fields"],
      },
    },
    run: async (ctx, i) => {
      const id = String(i.id);
      const f = i.fields ?? {};
      let r: { id: string; name: string };
      if (i.type === "property") r = await updateProperty(ctx.env, ctx.orgId, id, propertySchema.partial().parse(f));
      else if (i.type === "building") r = await updateBuilding(ctx.env, ctx.orgId, id, buildingSchema.omit({ property_id: true }).partial().parse(f));
      else if (i.type === "floor") r = await updateFloor(ctx.env, ctx.orgId, id, floorSchema.omit({ building_id: true }).partial().parse(f));
      else if (i.type === "room") r = await updateRoom(ctx.env, ctx.orgId, id, roomSchema.partial().parse(f));
      else throw new Error("Ukjent type");
      return { content: json({ ok: true }), summary: r.name, link: { type: i.type, id, label: r.name } };
    },
  },

  // ── Komponenter ──
  {
    group: "components",
    label: () => "Søker i FDV-registeret",
    tool: {
      name: "list_components",
      description:
        "Lister komponenter i FDV-registeret (tekniske anlegg og utstyr) med NS 3451-kode, TFM, produsent, serviceintervall, siste/neste service og tilstandsgrad.",
      input_schema: {
        type: "object",
        properties: {
          building_id: idProp("bygget"),
          floor_id: idProp("etasjen"),
          room_id: idProp("rommet"),
          ns3451: { type: "string", description: "Prefiks for NS 3451-kode, f.eks. 36 for luftbehandling" },
          query: { type: "string", description: "Fritekst i navn, produsent, modell, TFM og kategori" },
          service_due_within_days: { ...int, description: "Bare komponenter med neste service innen så mange dager (inkl. forfalte)" },
        },
      },
    },
    run: async (ctx, i) => {
      const hasLoc = i.building_id || i.floor_id || i.room_id;
      const comps = await listComponents(ctx.env, ctx.orgId, {
        building_id: i.building_id ?? (hasLoc ? null : ctx.scope.building_id),
        property_id: hasLoc ? null : ctx.scope.property_id,
        floor_id: i.floor_id,
        room_id: i.room_id,
        ns3451: i.ns3451,
        q: i.query,
        service_due_before: i.service_due_within_days != null ? inDays(Number(i.service_due_within_days)) : null,
        limit: 300,
      });
      const rows = comps.map((c) => ({
        id: c.id,
        name: c.name,
        ns3451: c.ns3451,
        tfm: c.tfm,
        manufacturer: c.manufacturer,
        model: c.model,
        location: [c.building_name, c.floor_name, c.room_name].filter(Boolean).join(" › "),
        service_interval_months: c.service_interval_months,
        last_service_at: c.last_service_at,
        next_service_at: c.next_service_at,
        condition: c.condition,
      }));
      return { content: json(rows), summary: `${rows.length} komponenter` };
    },
  },
  {
    group: "components",
    label: () => "Henter komponent",
    tool: {
      name: "get_component",
      description: "Henter alle detaljer om en komponent, inkludert tilknyttede dokumenter og oppgaver.",
      input_schema: { type: "object", properties: { component_id: idProp("komponenten") }, required: ["component_id"] },
    },
    run: async (ctx, i) => {
      const c = await getComponent(ctx.env, ctx.orgId, String(i.component_id));
      const [docs, tasks] = await Promise.all([
        listDocuments(ctx.env, ctx.orgId, { component_id: c.id }),
        listTasks(ctx.env, ctx.orgId, { component_id: c.id, status: "all", limit: 30 }),
      ]);
      return {
        content: json({
          ...c,
          documents: docs.map((d) => ({ id: d.id, title: d.title, kind: d.kind })),
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, type: t.type })),
        }),
        summary: c.name,
        link: { type: "component", id: c.id, label: c.name },
      };
    },
  },
  {
    group: "components_write",
    label: (i) => (i.component_id ? "Oppdaterer komponent" : `Registrerer «${i.name ?? "komponent"}»`),
    tool: {
      name: "save_component",
      description:
        "Oppretter en ny komponent (uten component_id) eller oppdaterer en eksisterende (med component_id). Neste service beregnes automatisk fra siste service + intervall. Datoer på formatet ÅÅÅÅ-MM-DD.",
      input_schema: {
        type: "object",
        properties: {
          component_id: idProp("komponenten som skal oppdateres (utelat for ny)"),
          name: str,
          building_id: str,
          floor_id: str,
          room_id: str,
          ns3451: str,
          tfm: str,
          category: str,
          manufacturer: str,
          model: str,
          serial_number: str,
          supplier: str,
          installed_at: str,
          warranty_until: str,
          service_interval_months: int,
          last_service_at: str,
          condition: { type: "string", enum: ["TG0", "TG1", "TG2", "TG3", "TGIU"] },
          ifc_guid: str,
          notes: str,
        },
      },
    },
    run: async (ctx, i) => {
      const { component_id, ...rest } = i;
      if (component_id) {
        const c = await updateComponent(ctx.env, ctx.orgId, String(component_id), componentSchema.partial().parse(rest));
        await logAgent(ctx, "component.updated", "component", c.id, `Oppdaterte ${c.name}`);
        return { content: json({ ok: true, id: c.id, next_service_at: c.next_service_at }), summary: c.name, link: { type: "component", id: c.id, label: c.name } };
      }
      const c = await createComponent(ctx.env, ctx.orgId, componentSchema.parse(rest));
      await logAgent(ctx, "component.created", "component", c.id, `Registrerte ${c.name}`);
      return { content: json({ ok: true, id: c.id, next_service_at: c.next_service_at }), summary: c.name, link: { type: "component", id: c.id, label: c.name } };
    },
  },

  // ── Oppgaver ──
  {
    group: "tasks",
    label: () => "Henter oppgaver",
    tool: {
      name: "list_tasks",
      description: "Lister oppgaver (vedlikehold, avvik, kontroller, dokumentasjon). Standard er åpne oppgaver.",
      input_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["open", "done", "all"], description: "open = åpne og pågående" },
          type: { type: "string", enum: ["vedlikehold", "avvik", "kontroll", "dokumentasjon", "annet"] },
          building_id: str,
          component_id: str,
          due_within_days: int,
          query: str,
        },
      },
    },
    run: async (ctx, i) => {
      const tasks = await listTasks(ctx.env, ctx.orgId, {
        status: i.status ?? "open",
        type: i.type,
        building_id: i.building_id ?? ctx.scope.building_id,
        property_id: i.building_id ? null : ctx.scope.property_id,
        component_id: i.component_id,
        due_before: i.due_within_days != null ? inDays(Number(i.due_within_days)) : null,
        q: i.query,
        limit: 200,
      });
      const rows = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        type: t.type,
        status: t.status,
        priority: t.priority,
        due_date: t.due_date,
        building: t.building_name,
        component: t.component_name,
        component_id: t.component_id,
        description: t.description ? truncate(t.description, 300) : null,
      }));
      return { content: json(rows), summary: `${rows.length} oppgaver` };
    },
  },
  {
    group: "tasks",
    label: (i) => `Oppretter oppgave «${truncate(String(i.title ?? ""), 50)}»`,
    tool: {
      name: "create_task",
      description:
        "Oppretter en oppgave: vedlikehold, avvik, kontroll, dokumentasjon eller annet. Knytt den til komponent og/eller plassering når det er mulig. Plassering hentes fra komponenten hvis ikke oppgitt.",
      input_schema: {
        type: "object",
        properties: {
          title: str,
          description: str,
          type: { type: "string", enum: ["vedlikehold", "avvik", "kontroll", "dokumentasjon", "annet"] },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          due_date: { type: "string", description: "ÅÅÅÅ-MM-DD" },
          property_id: str,
          building_id: str,
          floor_id: str,
          room_id: str,
          component_id: str,
          assignee: str,
        },
        required: ["title", "type"],
      },
    },
    run: async (ctx, i) => {
      const t = await createTask(ctx.env, ctx.orgId, taskSchema.parse(i), { agentId: ctx.agent.id });
      await logAgent(ctx, "task.created", "task", t.id, t.title);
      return { content: json({ ok: true, id: t.id }), summary: t.title, link: { type: "task", id: t.id, label: t.title } };
    },
  },
  {
    group: "tasks",
    label: () => "Oppdaterer oppgave",
    tool: {
      name: "update_task",
      description: "Oppdaterer en oppgave (status, prioritet, frist, tittel, beskrivelse, ansvarlig).",
      input_schema: {
        type: "object",
        properties: {
          task_id: str,
          status: { type: "string", enum: ["open", "in_progress", "done", "cancelled"] },
          priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
          due_date: str,
          title: str,
          description: str,
          assignee: str,
        },
        required: ["task_id"],
      },
    },
    run: async (ctx, i) => {
      const { task_id, ...patch } = i;
      const t = await updateTask(ctx.env, ctx.orgId, String(task_id), taskPatchSchema.parse(patch));
      await logAgent(ctx, "task.updated", "task", t.id, t.title);
      return { content: json({ ok: true, id: t.id, status: t.status }), summary: t.title, link: { type: "task", id: t.id, label: t.title } };
    },
  },

  // ── Artifacts ──
  {
    group: "artifacts",
    label: (i) => `Bygger siden «${truncate(String(i.title ?? ""), 50)}»`,
    tool: {
      name: "create_artifact",
      description: "Oppretter en ny side (artifact): et komplett, selvstendig HTML-dokument som vises i Plank og henter levende data via window.plank.",
      input_schema: {
        type: "object",
        properties: {
          title: str,
          description: { type: "string", description: "Én setning om hva siden viser" },
          html: { type: "string", description: "Komplett HTML-dokument" },
          building_id: idProp("bygget siden hører til (valgfritt)"),
          property_id: idProp("eiendommen siden hører til (valgfritt)"),
        },
        required: ["title", "html"],
      },
    },
    run: async (ctx, i) => {
      const a = await createArtifact(
        ctx.env,
        ctx.orgId,
        {
          title: String(i.title),
          description: i.description ?? null,
          html: String(i.html ?? ""),
          building_id: i.building_id ?? ctx.scope.building_id,
          property_id: i.property_id ?? ctx.scope.property_id,
          conversation_id: ctx.conversationId,
        },
        { agentId: ctx.agent.id },
      );
      await logAgent(ctx, "artifact.created", "artifact", a.id, a.title);
      return { content: json({ ok: true, artifact_id: a.id, version: 1 }), summary: a.title, link: { type: "artifact", id: a.id, label: a.title } };
    },
  },
  {
    group: "artifacts",
    label: () => "Oppdaterer siden",
    tool: {
      name: "update_artifact",
      description: "Lagrer en ny versjon av en eksisterende side. Send hele det oppdaterte HTML-dokumentet. Les gjeldende versjon med get_artifact først.",
      input_schema: {
        type: "object",
        properties: { artifact_id: str, html: str, change_note: { type: "string", description: "Kort beskrivelse av endringen" }, title: str },
        required: ["artifact_id", "html", "change_note"],
      },
    },
    run: async (ctx, i) => {
      const a = await saveArtifactVersion(ctx.env, ctx.orgId, String(i.artifact_id), { html: String(i.html ?? ""), note: i.change_note, title: i.title }, { agentId: ctx.agent.id });
      return { content: json({ ok: true, artifact_id: a.id, version: a.current_version }), summary: `${a.title} (v${a.current_version})`, link: { type: "artifact", id: a.id, label: a.title } };
    },
  },
  {
    group: "artifacts",
    label: () => "Leser siden",
    tool: {
      name: "get_artifact",
      description: "Henter HTML for gjeldende versjon av en side.",
      input_schema: { type: "object", properties: { artifact_id: str }, required: ["artifact_id"] },
    },
    run: async (ctx, i) => {
      const r = await getArtifactHtml(ctx.env, ctx.orgId, String(i.artifact_id));
      return {
        content: `${json({ id: r.artifact.id, title: r.artifact.title, version: r.version })}\n\n${r.html}`,
        summary: r.artifact.title,
        link: { type: "artifact", id: r.artifact.id, label: r.artifact.title },
      };
    },
  },
  {
    group: "artifacts",
    label: () => "Lister sider",
    tool: {
      name: "list_artifacts",
      description: "Lister eksisterende sider (artifacts).",
      input_schema: { type: "object", properties: { building_id: str } },
    },
    run: async (ctx, i) => {
      const list = await listArtifacts(ctx.env, ctx.orgId, { building_id: i.building_id });
      return {
        content: json(list.map((a) => ({ id: a.id, title: a.title, description: a.description, building: a.building_name, version: a.current_version }))),
        summary: `${list.length} sider`,
      };
    },
  },

  // ── IFC ──
  {
    group: "ifc",
    label: () => "Henter BIM-modeller",
    tool: {
      name: "ifc_overview",
      description: "Lister indekserte IFC-modeller med antall elementer per IFC-type og per etasje.",
      input_schema: { type: "object", properties: { building_id: str } },
    },
    run: async (ctx, i) => {
      const buildingId = i.building_id ?? ctx.scope.building_id;
      const rows = await all<{ id: string; title: string; building_id: string | null; building_name: string | null; schema: string | null; stats: string | null; indexed_at: number | null }>(
        ctx.env.DB,
        `SELECT d.id, d.title, d.building_id, b.name AS building_name, m.schema, m.stats, m.indexed_at
         FROM documents d LEFT JOIN ifc_models m ON m.document_id = d.id LEFT JOIN buildings b ON b.id = d.building_id
         WHERE d.org_id = ? AND d.kind = 'ifc' ${buildingId ? "AND d.building_id = ?" : ""}`,
        ...(buildingId ? [ctx.orgId, buildingId] : [ctx.orgId]),
      );
      const out = rows.map((r) => ({ ...r, stats: parseJson(r.stats, null), indexed: Boolean(r.indexed_at) }));
      return {
        content: out.length
          ? json(out) + (out.some((o) => !o.indexed) ? "\n\nMerk: Modeller som ikke er indeksert må åpnes i BIM-vieweren i Plank én gang for å bli indeksert." : "")
          : "Ingen IFC-modeller funnet.",
        summary: `${out.length} modeller`,
      };
    },
  },
  {
    group: "ifc",
    label: (i) => `Spør BIM-modellen${i.ifc_type ? ` (${i.ifc_type})` : ""}`,
    tool: {
      name: "query_ifc_elements",
      description:
        "Søker blant elementer i indekserte IFC-modeller. Filtrer på IFC-type (f.eks. IFCDOOR, IFCSPACE, IFCFLOWTERMINAL – * som jokertegn), etasjenavn og fritekst i navn/egenskaper. Returnerer GUID, type, navn, etasje og utvalgte egenskaper.",
      input_schema: {
        type: "object",
        properties: { building_id: str, ifc_type: str, storey: str, query: str, guid: str, limit: { ...int, description: "Maks 500" } },
      },
    },
    run: async (ctx, i) => {
      const rows = await queryIfcElements(ctx.env, ctx.orgId, {
        building_id: i.building_id ?? ctx.scope.building_id,
        ifc_type: i.ifc_type ? String(i.ifc_type).toUpperCase() : null,
        storey: i.storey,
        q: i.query,
        guid: i.guid,
        limit: Math.min(Number(i.limit ?? 100), 500),
      });
      return { content: json(rows), summary: `${rows.length} elementer` };
    },
  },

  // ── E-post ──
  {
    group: "email",
    label: (i) => `Sender e-post: «${truncate(String(i.subject ?? ""), 50)}»`,
    tool: {
      name: "send_email",
      description:
        "Sender e-post via Plank. Mottakere må være medlemmer av organisasjonen eller stå på agentens varslingsliste. Innholdet skrives i markdown; lenker på formen plank://type/id gjøres om til lenker inn i Plank.",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" }, description: "E-postadresser" },
          subject: str,
          body_markdown: str,
        },
        required: ["to", "subject", "body_markdown"],
      },
    },
    run: async (ctx, i) => {
      if (!emailConfigured(ctx.env)) return { content: "E-post er ikke konfigurert i denne installasjonen (RESEND_API_KEY mangler).", summary: "E-post ikke konfigurert", isError: true };
      const to = (Array.isArray(i.to) ? i.to : [i.to]).map((e: unknown) => String(e).trim().toLowerCase()).filter(Boolean);
      const members = await all<{ email: string }>(ctx.env.DB, `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?`, ctx.orgId);
      const allowed = new Set([...members.map((m) => m.email), ...parseJson<string[]>(ctx.agent.notify_emails, []).map((e) => e.toLowerCase())]);
      const rejected = to.filter((e: string) => !allowed.has(e));
      if (rejected.length) return { content: `Disse mottakerne er ikke tillatt: ${rejected.join(", ")}. Tillatt er medlemmer og agentens varslingsliste.`, summary: "Mottaker ikke tillatt", isError: true };
      if (to.length === 0 || to.length > 20) return { content: "Oppgi 1–20 mottakere.", summary: "Ugyldige mottakere", isError: true };
      const html = await renderEmailMarkdown(ctx.env, ctx.orgId, String(i.body_markdown ?? ""));
      await sendEmail(ctx.env, {
        to,
        subject: String(i.subject).slice(0, 200),
        html: emailLayout({ title: String(i.subject).slice(0, 200), bodyHtml: html, footer: `Sendt av agenten «${escapeHtml(ctx.agent.name)}» i Plank.` }),
      });
      return { content: json({ ok: true, sent_to: to }), summary: `Sendt til ${to.length} mottaker${to.length === 1 ? "" : "e"}` };
    },
  },
];

const ENTITY_PATHS: Record<string, string> = {
  property: "properties",
  building: "buildings",
  floor: "floors",
  room: "rooms",
  document: "documents",
  component: "components",
  task: "tasks",
  artifact: "artifacts",
};

/** Markdown → trygg HTML for e-post. Rå HTML escapes, plank://-lenker gjøres absolutte. */
export async function renderEmailMarkdown(env: Env, orgId: string, md: string): Promise<string> {
  const base = env.APP_URL.replace(/\/$/, "");
  const safe = md
    .replace(/</g, "&lt;")
    .replace(/plank:\/\/(\w+)\/([\w-]+)/g, (_m, type: string, id: string) => `${base}/o/${orgId}/${ENTITY_PATHS[type] ?? type}/${id}`);
  return marked.parse(safe, { async: false }) as string;
}

// ─── Oppslag ─────────────────────────────────────────────────────────────────

export function toolsFor(groups: ToolGroup[]): { tools: (ClaudeTool | ServerTool)[]; defs: Map<string, ToolDef> } {
  const set = new Set(groups);
  const defs = new Map<string, ToolDef>();
  for (const t of TOOLS) if (set.has(t.group)) defs.set(t.tool.name, t);
  // Servertverktøy først, slik at cache-breakpointet kan ligge på siste klientverktøy
  const tools: (ClaudeTool | ServerTool)[] = [];
  if (set.has("web")) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
  tools.push(...[...defs.values()].map((d) => ({ ...d.tool })));
  return { tools, defs };
}

export function toolLabel(defs: Map<string, ToolDef>, name: string, input: unknown): string {
  if (name === "web_search") return `Søker på nettet${(input as { query?: string })?.query ? ` etter «${truncate(String((input as { query?: string }).query), 60)}»` : ""}`;
  const d = defs.get(name);
  try {
    return d ? d.label(input ?? {}) : name;
  } catch {
    return name;
  }
}

export async function executeTool(ctx: ToolContext, defs: Map<string, ToolDef>, name: string, input: unknown): Promise<ToolOutcome> {
  const def = defs.get(name);
  if (!def) return { content: `Ukjent eller ikke tillatt verktøy: ${name}`, summary: "Ukjent verktøy", isError: true };
  try {
    return await def.run(ctx, (input ?? {}) as Record<string, unknown>);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const zodIssues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    const detail = zodIssues ? zodIssues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : msg;
    return { content: `Feil: ${detail}`, summary: truncate(detail, 120), isError: true };
  }
}

/** Finn scope (eiendom/bygg) for agenten */
export async function resolveScope(env: Env, agent: AgentRow): Promise<{ property_id: string | null; building_id: string | null; label: string | null }> {
  if (agent.scope_type === "building" && agent.scope_id) {
    const b = await first<{ property_id: string; name: string }>(env.DB, `SELECT property_id, name FROM buildings WHERE id = ? AND org_id = ?`, agent.scope_id, agent.org_id);
    if (b) return { property_id: b.property_id, building_id: agent.scope_id, label: `bygget «${b.name}» (id ${agent.scope_id})` };
  }
  if (agent.scope_type === "property" && agent.scope_id) {
    const p = await first<{ name: string }>(env.DB, `SELECT name FROM properties WHERE id = ? AND org_id = ?`, agent.scope_id, agent.org_id);
    if (p) return { property_id: agent.scope_id, building_id: null, label: `eiendommen «${p.name}» (id ${agent.scope_id})` };
  }
  return { property_id: null, building_id: null, label: null };
}

