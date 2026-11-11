import { FileText, GitBranch, Rss, Search, UserRound } from "lucide-react";
import type { ComponentType } from "react";

export type NavItem = {
  id: "feed" | "search" | "profile" | "sources" | "engine";
  to: "/" | null; // null = chưa có trang
  Icon: ComponentType<{ "aria-hidden"?: boolean }>;
  group: "main" | "owner";
};

// Trang nào có route thì điền `to`; chưa có thì null (hiện xám, nhãn "Sắp có").
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "feed", to: "/", Icon: FileText, group: "main" },
  { id: "search", to: null, Icon: Search, group: "main" },
  { id: "profile", to: null, Icon: UserRound, group: "main" },
  { id: "sources", to: null, Icon: Rss, group: "owner" },
  { id: "engine", to: null, Icon: GitBranch, group: "owner" },
];
