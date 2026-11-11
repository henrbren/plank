import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { createBrowserRouter, Navigate, useRouteError } from "react-router";
import { Button, Loading } from "./components/ui";
import { clearChunkReload, isChunkError, reloadOnceForStaleChunk } from "./lib/chunk";
import { LoginPage, OnboardingPage, RootRedirect, SendDemoPage, VerifyPage, WaitingPage } from "./pages/auth";
import { VippsCallbackPage } from "./features/auth/VippsCallback";
import { FunnelPage } from "./features/onboarding/Funnel";
import { OrgLayout } from "./components/OrgLayout";
import { HomePage } from "./pages/home";
import { DeskCasePage, DeskPage } from "./pages/desk";
import { BuildingPage, FloorPage, PropertyPage, RoomPage } from "./pages/portfolio";
import { DocumentPage, DocumentsPage } from "./pages/documents";
import { ComponentPage, ComponentsPage } from "./pages/components";
import { TasksPage } from "./pages/tasks";
import { AgentEditPage, AgentsPage } from "./pages/agents";
import { ArtifactPage, ArtifactsPage } from "./pages/artifacts";
import { SharePage } from "./pages/share";
import { SubscriptionPage } from "./pages/subscription";
import { SettingsPage } from "./pages/settings";
import { AccessPage } from "./pages/access";
import { BoligmappaPage } from "./pages/boligmappa";
import { LaftPage } from "./pages/laft";
import { AdminHome, AdminLayout, AdminOrg } from "./pages/admin";
import { ConversationPage } from "./pages/conversation";
import { HelpArticlePage, HelpPage } from "./pages/help";
import { NotFound } from "./pages/notfound";
import { ModuleGate } from "./lib/modules";
import { useBrand } from "./lib/brand";
import { brandFromHost } from "@shared/brand";

// IFC-vieweren (three.js + web-ifc) og kartet lastes først når de trengs.
// Etter en deploy kan fanen be om et skript som ikke finnes lenger. Da laster vi siden på nytt én gang.
function OrgIndex() {
  const brand = useBrand();
  if (brand.id === "leie") return <DeskPage />;
  return <HomePage />;
}

function lazyPage(loader: () => Promise<{ default: ComponentType }>) {
  return lazy(() =>
    loader().catch((err: unknown) => {
      if (isChunkError(err) && reloadOnceForStaleChunk()) return new Promise(() => {});
      throw err;
    }),
  );
}

const ModelPage = lazyPage(() => import("./features/ifc/ModelPage"));
const MapPage = lazyPage(() => import("./pages/map"));

const lazyEl = (el: ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;

function RouteError() {
  const error = useRouteError();
  const stale = isChunkError(error);
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="max-w-md text-center">
        <h1 className="text-[16px] font-semibold">{stale ? `${brandFromHost(location.hostname).name} er oppdatert` : "Noe gikk galt"}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          {stale ? "Last siden på nytt for å hente den nye versjonen." : "Last siden på nytt, og prøv igjen."}
        </p>
        <Button
          variant="primary"
          className="mt-5"
          onClick={() => {
            clearChunkReload();
            location.reload();
          }}
        >
          Last på nytt
        </Button>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    children: [
  { path: "/", element: <RootRedirect /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/demo", element: <SendDemoPage /> },
  { path: "/auth/verify", element: <VerifyPage /> },
  { path: "/auth/vipps", element: <VippsCallbackPage /> },
  { path: "/onboarding", element: <OnboardingPage /> },
  { path: "/venter", element: <WaitingPage /> },
  { path: "/velkommen/:orgId", element: <FunnelPage /> },
  { path: "/s/:token", element: <SharePage /> },
  {
    path: "/admin",
    element: <AdminLayout />,
    children: [
      { index: true, element: <AdminHome /> },
      { path: ":orgId", element: <AdminOrg /> },
    ],
  },
  {
    path: "/o/:orgId",
    element: <OrgLayout />,
    children: [
      { index: true, element: <OrgIndex /> },
      { path: "pult", element: <ModuleGate module="utleie"><DeskPage /></ModuleGate> },
      { path: "pult/:caseId", element: <ModuleGate module="utleie"><DeskCasePage /></ModuleGate> },
      { path: "drift", element: <ModuleGate module="drift"><HomePage /></ModuleGate> },
      { path: "kart", element: <ModuleGate module="kart">{lazyEl(<MapPage />)}</ModuleGate> },
      { path: "properties/:id", element: <PropertyPage /> },
      { path: "buildings/:id", element: <BuildingPage /> },
      { path: "floors/:id", element: <FloorPage /> },
      { path: "rooms/:id", element: <RoomPage /> },
      { path: "documents", element: <ModuleGate module="dokumenter"><DocumentsPage /></ModuleGate> },
      { path: "documents/:id", element: <ModuleGate module="dokumenter"><DocumentPage /></ModuleGate> },
      { path: "components", element: <ModuleGate module="komponenter"><ComponentsPage /></ModuleGate> },
      { path: "components/:id", element: <ModuleGate module="komponenter"><ComponentPage /></ModuleGate> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:id", element: <TasksPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/new", element: <AgentEditPage /> },
      { path: "agents/:id", element: <AgentEditPage /> },
      { path: "artifacts", element: <ModuleGate module="sider"><ArtifactsPage /></ModuleGate> },
      { path: "artifacts/:id", element: <ModuleGate module="sider"><ArtifactPage /></ModuleGate> },
      { path: "models/:id", element: <ModuleGate module="drift">{lazyEl(<ModelPage />)}</ModuleGate> },
      { path: "conversations/:id", element: <ConversationPage /> },
      { path: "boligmappa", element: <ModuleGate module="drift"><BoligmappaPage /></ModuleGate> },
      { path: "laft", element: <ModuleGate module="drift"><LaftPage /></ModuleGate> },
      { path: "abonnement", element: <SubscriptionPage /> },
      { path: "pris", element: <Navigate to="../abonnement" replace /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "tilganger", element: <AccessPage /> },
      { path: "hjelp", element: <HelpPage /> },
      { path: "hjelp/:slug", element: <HelpArticlePage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
