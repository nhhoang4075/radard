import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import "./select.css";

export type SelectOption<T extends string> = { value: T; label: string };

/** Chọn một giá trị. Hành vi (mở/đóng, focus, Esc, nhấp ra ngoài) do Radix Popover; giao diện là rd-*. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (v: T) => void;
  label: string; // tên đọc của ô chọn
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="rd-chip rd-select-trigger"
          aria-label={label}
          aria-haspopup="listbox"
        >
          <span>{current?.label ?? ""}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="rd-select-menu rd-select-menu-fit" align="start" sideOffset={6}>
          <div role="listbox" aria-label={label} className="rd-select-list">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className="rd-select-option"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span>{o.label}</span>
                <Check aria-hidden="true" />
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Nút "+N" chọn nhiều, có ô tìm. Menu ở lại khi chọn; đóng bằng Esc hoặc nhấp ra ngoài. */
export function MultiSelect<T extends string>({
  values,
  options,
  onChange,
  triggerLabel,
  searchPlaceholder,
  emptyLabel,
}: {
  values: ReadonlySet<T>;
  options: readonly SelectOption<T>[];
  onChange: (next: Set<T>) => void;
  triggerLabel: string; // ví dụ "+5"
  searchPlaceholder: string;
  emptyLabel: string;
}) {
  const [q, setQ] = useState("");
  const id = useId();
  const shown = useMemo(() => {
    const k = q.trim().toLocaleLowerCase("vi");
    return k ? options.filter((o) => o.label.toLocaleLowerCase("vi").includes(k)) : options;
  }, [options, q]);
  const toggle = (v: T) => {
    const next = new Set(values);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next);
  };
  return (
    <Popover.Root onOpenChange={(o) => o || setQ("")}>
      <Popover.Trigger asChild>
        <button type="button" className="rd-chip rd-select-more" aria-haspopup="listbox">
          {triggerLabel}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="rd-select-menu" align="start" sideOffset={6}>
          <input
            className="rd-select-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-controls={id}
          />
          <div id={id} role="listbox" aria-multiselectable="true" className="rd-select-list">
            {shown.length === 0 ? <div className="rd-select-empty">{emptyLabel}</div> : null}
            {shown.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={values.has(o.value)}
                className="rd-select-option"
                onClick={() => toggle(o.value)}
              >
                <span>{o.label}</span>
                <Check aria-hidden="true" />
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
