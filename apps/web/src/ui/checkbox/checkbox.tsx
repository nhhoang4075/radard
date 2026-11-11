import type { InputHTMLAttributes, ReactNode } from "react";
import "./checkbox.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function Checkbox(props: Props) {
  return (
    <input {...props} type="checkbox" className={`rd-checkbox ${props.className ?? ""}`.trim()} />
  );
}

/** Hàng ô tích + nhãn (+ số đếm bên phải). */
export function CheckRow({ label, count, ...rest }: Props & { label: ReactNode; count?: number }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: ô tích nằm trong label qua <Checkbox/>
    <label className="rd-check">
      <Checkbox {...rest} />
      <span>{label}</span>
      {count === undefined ? null : <span className="rd-check-n">{count}</span>}
    </label>
  );
}

/** Thẻ chọn: chọn = viền đậm hơn (cùng 1px). */
export function CheckCard({
  label,
  dashed,
  ...rest
}: Props & { label: ReactNode; dashed?: boolean }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: ô tích nằm trong label qua <Checkbox/>
    <label className="rd-check-card" data-dashed={dashed ? "" : undefined}>
      <Checkbox {...rest} />
      <span>{label}</span>
    </label>
  );
}
