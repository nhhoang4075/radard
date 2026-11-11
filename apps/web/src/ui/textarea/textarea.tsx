import type { TextareaHTMLAttributes } from "react";
import "./textarea.css";

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`rd-textarea ${props.className ?? ""}`.trim()} />;
}
