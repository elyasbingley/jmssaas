import { MODULE_GROUPS } from "../lib/modules";
import { ModuleTile } from "../components/ModuleTile";

// Every module in the app as tiles (the top bar's "More").
export default function MorePage() {
  return (
    <div className="mx-auto max-w-7xl p-8" style={{ fontFamily: "var(--jms-font)" }}>
      <h1 className="mb-6 uppercase tracking-widest" style={{ color: "var(--jms-accent)", fontSize: "var(--jms-font-title)" }}>
        More
      </h1>
      {MODULE_GROUPS.map((group) => (
        <section key={group.heading} className="mb-8">
          <h2 className="mb-3 font-bold uppercase tracking-wide" style={{ color: "var(--jms-text-muted)", fontSize: "var(--jms-font-label)", letterSpacing: "0.1em" }}>
            {group.heading}
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {group.modules.map((m) => (
              <ModuleTile key={m.to} module={m} showBlurb />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
