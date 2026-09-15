import type { Cheatsheet } from "@/lib/api";

export function CheatsheetView({ sheet }: { sheet: Cheatsheet }) {
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5 shadow-sm print:shadow-none">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">{sheet.title}</h2>
        <button
          type="button"
          onClick={() => window.print()}
          className="shrink-0 text-sm text-muted underline underline-offset-4 print:hidden"
        >
          Print
        </button>
      </div>
      {sheet.blocks.map((block) => (
        <div key={block.heading} className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-tutor">{block.heading}</h3>
          <ul className="space-y-1.5">
            {block.points.map((point, i) => (
              <li key={i} className="flex justify-between gap-3 rounded-xl bg-ground px-3 py-2 text-sm">
                <span>{point.text}</span>
                {point.sourceRef ? <span className="shrink-0 text-xs text-muted">{point.sourceRef}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="text-xs text-muted">Made only from this material. The note on each line says where it came from.</p>
    </section>
  );
}
