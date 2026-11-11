import type { ReactNode } from "react";
import "./badge.css";

export type BadgeStatus = "ok" | "warn" | "bad" | "off" | "run";

export function Badge({ status, children }: { status: BadgeStatus; children: ReactNode }) {
  return (
    <span className="rd-badge" data-s={status}>
      {children}
    </span>
  );
}
