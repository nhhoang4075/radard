import type { CSSProperties } from "react";
import "./skeleton.css";

export function Skeleton({
  width,
  height,
  style,
}: {
  width?: string;
  height?: string;
  style?: CSSProperties;
}) {
  return <span className="rd-skeleton" aria-hidden="true" style={{ width, height, ...style }} />;
}
