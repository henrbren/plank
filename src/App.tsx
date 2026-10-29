import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { Loading } from "./components/ui";
import { LoginPage, OnboardingPage, RootRedirect, SendDemoPage, VerifyPage, WaitingPage } from "./pages/auth";
import { VippsCallbackPage } from "./features/auth/VippsCallback";
import { FunnelPage } from "./features/onboarding/Funnel";
import { OrgLayout } from "./components/OrgLayout";
import { HomePage } from "./pages/home";
import { BuildingPage, FloorPage, PropertyPage, RoomPage } from "./pages/portfolio";
import { DocumentPage, DocumentsPage } from "./pages/documents";
import { ComponentPage, ComponentsPage } from "./pages/components";
import { TasksPage } from "./pages/tasks";
import { AgentEditPage, AgentsPage } from "./pages/agents";
import { ArtifactPage, ArtifactsPage } from "./pages/artifacts";
import { SubscriptionPage } from "./pages/subscription";
import { SettingsPage } from "./pages/settings";
import { AccessPage } from "./pages/access";
import { BoligmappaPage } from "./pages/boligmappa";
import { LaftPage } from "./pages/laft";
import { AdminHome, AdminLayout, AdminOrg } from "./pages/admin";
import { ConversationPage } from "./pages/conversation";
import { HelpArticlePage, HelpPage } from "./pages/help";
import { NotFound } from "./pages/notfound";

// IFC-vieweren (three.js + web-ifc) lastes først når den trengs
const ModelPage = lazy(() => import("./features/ifc/ModelPage"));

const lazyEl = (el: ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;

export const router = createBrowserRouter([
  { path: "/", element: <RootRedirect /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/demo", element: <SendDemoPage /> },
  { path: "/auth/verify", element: <VerifyPage /> },
  { path: "/auth/vipps", element: <VippsCallbackPage /> },
  { path: "/onboarding", element: <OnboardingPage /> },
  { path: "/venter", element: <WaitingPage /> },
  { path: "/velkommen/:orgId", element: <FunnelPage /> },
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
      { index: true, element: <HomePage /> },
      { path: "properties/:id", element: <PropertyPage /> },
      { path: "buildings/:id", element: <BuildingPage /> },
      { path: "floors/:id", element: <FloorPage /> },
      { path: "rooms/:id", element: <RoomPage /> },
      { path: "documents", element: <DocumentsPage /> },
      { path: "documents/:id", element: <DocumentPage /> },
      { path: "components", element: <ComponentsPage /> },
      { path: "components/:id", element: <ComponentPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:id", element: <TasksPage /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/new", element: <AgentEditPage /> },
      { path: "agents/:id", element: <AgentEditPage /> },
      { path: "artifacts", element: <ArtifactsPage /> },
      { path: "artifacts/:id", element: <ArtifactPage /> },
      { path: "models/:id", element: lazyEl(<ModelPage />) },
      { path: "conversations/:id", element: <ConversationPage /> },
      { path: "boligmappa", element: <BoligmappaPage /> },
      { path: "laft", element: <LaftPage /> },
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
]);
