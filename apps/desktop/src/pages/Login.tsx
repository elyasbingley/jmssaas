import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth-context";
import { getErrorMessage } from "../lib/errors";

export default function LoginPage() {
  const { session, isLoading, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in - bounce straight past the login form. The state
  // (App.tsx's RequireAdmin) sends people here with the page they were
  // trying to reach, so a direct link works after signing in too.
  const from = (location.state as { from?: string } | null)?.from ?? "/dispatch";
  if (!isLoading && session) return <Navigate to={from} replace />;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (e) {
      setError(getErrorMessage(e, "Sign in failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-lg border border-gray-300 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-bold text-gray-900">Bingley Job Management</h1>
        <p className="mb-6 text-sm text-gray-500">Admin sign in</p>

        <label className="mb-1 block text-sm font-semibold text-gray-700" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          required
        />

        <label className="mb-1 block text-sm font-semibold text-gray-700" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          required
        />

        {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-blue-700 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
