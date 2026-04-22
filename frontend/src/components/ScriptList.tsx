"use client";
import { useEffect, useRef } from "react";
import { Block } from "@/lib/types";
import { formatTime } from "@/lib/format";

interface Props {
  blocks: Block[];
  activeIndex: number | null;
  onJump: (index: number) => void;
  onTextChange: (index: number, text: string) => void;
}

export default function ScriptList({
  blocks,
  activeIndex,
  onJump,
  onTextChange,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeIndex == null) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIndex}"]`
    );
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIndex]);

  return (
    <div ref={listRef} className="overflow-y-auto h-full">
      {blocks.map((b) => {
        const active = activeIndex === b.index;
        return (
          <div
            key={b.index}
            data-idx={b.index}
            onClick={() => onJump(b.index)}
            className={`px-4 py-3 border-b border-border cursor-pointer flex gap-3 items-start ${
              active ? "bg-accent/10" : "hover:bg-panel"
            }`}
          >
            <div className="text-xs text-muted font-mono pt-1 w-20 shrink-0">
              {formatTime(b.start)}
            </div>
            <textarea
              defaultValue={b.text}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => onTextChange(b.index, e.target.value)}
              rows={1}
              className="flex-1 bg-transparent resize-none outline-none text-sm leading-relaxed focus:ring-1 focus:ring-accent rounded px-1"
            />
          </div>
        );
      })}
    </div>
  );
}
