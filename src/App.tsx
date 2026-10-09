import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { Loading } from "./components/ui";
import { LoginPage, OnboardingPage, RootRedirect, VerifyPage } from "./pages/auth";
import { OrgLayout } from "./components/OrgLayout";
import { HomePage } from "./pages/home";
import { BuildingPage, FloorPage, PropertyPage, RoomPage } from "./pages/portfolio";
import { DocumentPage, DocumentsPage } from "./pages/documents";
import { ComponentPage, ComponentsPage } from "./pages/components";
import { TasksPage } from "./pages/tasks";
import { AgentEditPage, AgentsPage } from "./pages/agents";
import { ArtifactPage, ArtifactsPage } from "./pages/artifacts";
import { SettingsPage } from "./pages/settings";
import { ConversationPage } from "./pages/conversation";
import { NotFound } from "./pages/notfound";

// IFC-vieweren (three.js + web-ifc) lastes først når den trengs
const ModelPage = lazy(() => import("./features/ifc/ModelPage"));

const lazyEl = (el: ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;

export const router = createBrowserRouter([
  { path: "/", element: <RootRedirect /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/auth/verify", element: <VerifyPage /> },
  { path: "/onboarding", element: <OnboardingPage /> },
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
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
