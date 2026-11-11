import * as RToast from "@radix-ui/react-toast";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import "./toast.css";

type Item = { id: number; text: string };
const Ctx = createContext<(text: string) => void>(() => {});

/** Wraps the app once; call `useToast()(text)` from anywhere. */
export function ToastProvider({
  children,
  closeLabel,
}: {
  children: ReactNode;
  closeLabel: string;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const push = useCallback(
    (text: string) => setItems((l) => [...l, { id: Date.now() + Math.random(), text }]),
    [],
  );
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      <RToast.Provider duration={2800} label={closeLabel}>
        {children}
        {items.map((t) => (
          <RToast.Root
            key={t.id}
            className="rd-toast"
            onOpenChange={(o) => o || setItems((l) => l.filter((x) => x.id !== t.id))}
          >
            <RToast.Description>{t.text}</RToast.Description>
          </RToast.Root>
        ))}
        <RToast.Viewport className="rd-toast-viewport" />
      </RToast.Provider>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
