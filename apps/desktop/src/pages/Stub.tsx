// Placeholder for screens not yet built in this foundation pass - see
// docs/SETUP.md's desktop known-gaps section. Each real page replaces its
// corresponding stub in App.tsx one at a time.
export function StubPage({ title }: { title: string }) {
  return (
    <div className="p-8">
      <h1 className="text-xl font-bold text-gray-900">{title}</h1>
      <p className="mt-2 text-sm text-gray-500">Not built yet.</p>
    </div>
  );
}
