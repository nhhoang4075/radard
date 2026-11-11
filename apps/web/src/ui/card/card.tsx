import type { HTMLAttributes } from "react";
import "./card.css";

export function Card(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`rd-card ${props.className ?? ""}`.trim()} />;
}
