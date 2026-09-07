import type { ReactNode } from "react";

// Right-side overlay panel, extracted from Tasks.tsx's own nested-route
// pattern (that page still rolls its own copy inline rather than being
// retrofitted to this - see Channels.tsx for the second, route-driven use
// of this exact shape via useMatch + <Outlet/>). Purely presentational:
// the caller decides what "open" means (a route match, local state, etc).
interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function SidePanel({ open, onClose, children }: SidePanelProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-y-auto border-l border-gray-300 bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
