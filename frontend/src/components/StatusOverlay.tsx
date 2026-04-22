"use client";

interface Props {
  message: string;
  detail?: string;
}

export default function StatusOverlay({ message, detail }: Props) {
  return (
    <div className="fixed inset-0 bg-bg/80 backdrop-blur flex items-center justify-center z-50">
      <div className="bg-panel border border-border rounded-2xl px-10 py-8 text-center max-w-sm">
        <div className="w-10 h-10 mx-auto mb-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <div className="text-base font-medium">{message}</div>
        {detail && (
          <div className="text-sm text-muted mt-2 leading-relaxed">{detail}</div>
        )}
      </div>
    </div>
  );
}
