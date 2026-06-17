import { useEffect, useState } from "react";
import { api, type Persona } from "../api";

export function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activeId, setActiveId] = useState("generalist");
  const [selectedId, setSelectedId] = useState("generalist");
  const [draft, setDraft] = useState<Persona | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const r = await api.getPersonas();
    setPersonas(r.personas);
    setActiveId(r.activePersona);
    setSelectedId((cur) => r.personas.find((p) => p.id === cur)?.id ?? r.activePersona);
  };
  useEffect(() => {
    void refresh();
  }, []);

  // When selection changes, load a fresh draft.
  useEffect(() => {
    const p = personas.find((x) => x.id === selectedId);
    setDraft(p ? { ...p } : null);
    setMsg(null);
  }, [selectedId, personas]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.updatePersona(draft.id, {
        name: draft.name,
        description: draft.description,
        workerPrompt: draft.workerPrompt,
        analysisPrompt: draft.analysisPrompt,
        synthesisPrompt: draft.synthesisPrompt,
      });
      setMsg("Saved.");
      await refresh();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const resetBuiltin = async () => {
    if (!draft?.builtin) return;
    if (!confirm(`Reset '${draft.name}' to its default prompts? Your edits will be lost.`)) return;
    setSaving(true);
    try {
      await api.updatePersona(draft.id, { reset: true });
      setMsg("Reset to default.");
      await refresh();
    } catch (e) {
      setMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const makeActive = async () => {
    if (!draft) return;
    // activePersona lives in config.settings -> use putConfig.
    await api.putConfig({ settings: { activePersona: draft.id } } as never);
    setActiveId(draft.id);
    setMsg(`'${draft.name}' is now the active persona.`);
  };

  const duplicate = async () => {
    if (!draft) return;
    const copy = await api.createPersona({
      name: `${draft.name} (copy)`,
      description: draft.description,
      workerPrompt: draft.workerPrompt,
      analysisPrompt: draft.analysisPrompt,
      synthesisPrompt: draft.synthesisPrompt,
    });
    await refresh();
    setSelectedId(copy.id);
  };

  const remove = async () => {
    if (!draft || draft.builtin) return;
    if (!confirm(`Delete persona '${draft.name}'?`)) return;
    const ok = await api.deletePersona(draft.id);
    if (ok) {
      await refresh();
      setSelectedId("generalist");
    } else {
      setMsg("Couldn't delete (is it the active persona?).");
    }
  };

  const createNew = async () => {
    const p = await api.createPersona({
      name: "New persona",
      description: "",
      workerPrompt: "You are an independent candidate model in a fusion panel…",
      analysisPrompt: "You are the ANALYSIS step of a fusion judge…",
      synthesisPrompt: "You are the SYNTHESIS step of a fusion judge…",
    });
    await refresh();
    setSelectedId(p.id);
  };

  return (
    <div className="flex gap-4">
      {/* List */}
      <aside className="glass w-56 flex-shrink-0 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Personas</h2>
          <button className="btn-icon" onClick={() => void createNew()} title="New persona">+</button>
        </div>
        <ul className="space-y-1">
          {personas.map((p) => (
            <li key={p.id}>
              <button
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition ${
                  p.id === selectedId ? "bg-[#4cd0b0]/20 text-[#4cd0b0]" : "text-white/75 hover:bg-white/10"
                }`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="flex items-center gap-1.5">
                  {p.id === activeId && <span title="active">●</span>}
                  {p.name}
                  {p.builtin && <span className="text-[0.6rem] uppercase text-white/40">builtin</span>}
                </span>
                {p.description && <span className="block truncate text-xs text-white/40">{p.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* Editor */}
      <section className="glass flex-1 p-5">
        {!draft ? (
          <p className="text-sm text-white/50">Select a persona, or click + to create one.</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input
                className="field flex-1 font-semibold"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              {draft.id !== activeId ? (
                <button className="btn" onClick={() => void makeActive()}>Set active</button>
              ) : (
                <span className="rounded-full bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">● Active</span>
              )}
              <button className="btn" onClick={() => void duplicate()}>Duplicate</button>
              {draft.builtin ? (
                <button className="btn" onClick={() => void resetBuiltin()}>Reset to default</button>
              ) : (
                <button className="btn" onClick={() => void remove()}>Delete</button>
              )}
              <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
            {msg && <p className="mb-3 text-sm text-white/70">{msg}</p>}
            <input
              className="field mb-4 w-full text-sm"
              placeholder="Short description (shown in the persona list)"
              value={draft.description ?? ""}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <PromptField
              label="Worker prompt (candidate stage)"
              hint="System prompt for each candidate model."
              value={draft.workerPrompt}
              onChange={(v) => setDraft({ ...draft, workerPrompt: v })}
            />
            <PromptField
              label="Judge — analysis prompt"
              hint="Step 1: forces the record_analysis tool call. Must instruct the judge to analyze, NOT answer."
              value={draft.analysisPrompt}
              onChange={(v) => setDraft({ ...draft, analysisPrompt: v })}
            />
            <PromptField
              label="Judge — synthesis prompt"
              hint="Step 2: writes the final answer from candidates + analysis only (no new info)."
              value={draft.synthesisPrompt}
              onChange={(v) => setDraft({ ...draft, synthesisPrompt: v })}
            />
          </>
        )}
      </section>
    </div>
  );
}

function PromptField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-4">
      <label className="text-sm font-medium text-[#4cd0b0]">{label}</label>
      <p className="mb-1 text-xs text-white/45">{hint}</p>
      <textarea
        className="field h-32 w-full font-mono text-xs leading-relaxed"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
