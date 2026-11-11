import { FileText, GitBranch, Rss, Search, UserRound } from "lucide-react";
import type { ComponentType } from "react";

export type NavItem = {
  id: "feed" | "search" | "profile" | "sources" | "engine";
  to: "/" | null; // null = no page yet
  Icon: ComponentType<{ "aria-hidden"?: boolean }>;
  group: "main" | "owner";
};

// Pages with a route fill `to`; without one it is null (shown grey, label "Sắp có").
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "feed", to: "/", Icon: FileText, group: "main" },
  { id: "search", to: null, Icon: Search, group: "main" },
  { id: "profile", to: null, Icon: UserRound, group: "main" },
  { id: "sources", to: null, Icon: Rss, group: "owner" },
  { id: "engine", to: null, Icon: GitBranch, group: "owner" },
];
