"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface ToastItem {
  id: number;
  message: string;
}

interface ToastCtx {
  show: (message: string) => void;
}

const Ctx = createContext<ToastCtx>({ show: () => {} });

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, message }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 2400);
  }, []);

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {items.map((t) => (
          <ToastBubble key={t.id} message={t.message} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastBubble({ message }: { message: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      className={`px-4 py-2 rounded-lg bg-panel border border-border text-sm shadow-lg transition-all duration-200 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      {message}
    </div>
  );
}
