import type { ReactNode } from "react";
import "./state.css";

/** Trạng thái rỗng / chờ / hết: tiêu đề đậm nhẹ + một dòng giải thích. */
export function State({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="rd-state">
      {title ? <b>{title}</b> : null}
      {children}
    </div>
  );
}
