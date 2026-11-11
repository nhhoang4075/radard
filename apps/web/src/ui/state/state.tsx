import type { ReactNode } from "react";
import "./state.css";

/** Empty / loading / end states: a slightly bold title + one line of explanation. */
export function State({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="rd-state">
      {title ? <b>{title}</b> : null}
      {children}
    </div>
  );
}
