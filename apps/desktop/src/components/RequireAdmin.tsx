import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth-context";

// Admin-only for now - technicians keep using mobile. A technician account
// can still authenticate against Supabase (signIn succeeds), but is
// rejected here post-login with a clear message rather than being blocked
// at the auth layer, same pattern as apps/mobile/app/company-settings.tsx
// uses for non-admins viewing an admin-only mobile screen. See
// docs/SETUP.md's desktop section for why this is a deliberate default,
// not an oversight.
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, profile, isLoading, isAdmin } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">
        Loading...
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm">
          <h1 className="mb-2 text-lg font-bold text-gray-900">Admin access only</h1>
          <p className="text-sm text-gray-500">
            {profile?.full_name ?? "This account"} doesn't have admin access to the
            desktop app. Use the mobile app instead, or contact an admin if you
            believe this is a mistake.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
