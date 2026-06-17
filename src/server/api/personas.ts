// GET/POST/PUT/DELETE /api/personas — manage the persona set (worker/analysis/synthesis prompt bundles).
// Personas live in config.json under `personas`; the active persona is set via PUT /api/config
// (settings.activePersona). Builtins (builtin: true) can be reset to the shipped defaults.
import { Router } from "express";
import { loadConfig, saveConfig } from "../../config/store.js";
import { BUILTIN_PERSONAS, getBuiltin, DEFAULT_PERSONA_ID } from "../../fusion/personas.js";

/** Ensure the stored persona list includes all builtins (merged on read). */
function withBuiltins(stored: { id: string; builtin?: boolean }[]): typeof BUILTIN_PERSONAS {
  const storedIds = new Set(stored.map((p) => p.id));
  const merged = [...stored];
  for (const b of BUILTIN_PERSONAS) {
    if (!storedIds.has(b.id)) merged.push({ ...b });
  }
  return merged as typeof BUILTIN_PERSONAS;
}

export function personasRouter(): Router {
  const r = Router();

  // GET: list all personas (stored + any missing builtins), plus the active id.
  r.get("/", (_req, res) => {
    const config = loadConfig();
    res.json({
      personas: withBuiltins(config.personas ?? []),
      activePersona: config.settings.activePersona ?? DEFAULT_PERSONA_ID,
    });
  });

  // POST: create a new persona (user-defined). Body: full Persona minus builtin.
  r.post("/", (req, res) => {
    const body = req.body ?? {};
    if (!body.name || !body.workerPrompt || !body.analysisPrompt || !body.synthesisPrompt) {
      const e = new Error("name, workerPrompt, analysisPrompt, synthesisPrompt are required");
      (e as Error & { code?: string }).code = "VALIDATION";
      throw e;
    }
    const config = loadConfig();
    const id = slugify(body.name) + "-" + Math.random().toString(36).slice(2, 7);
    const persona = { id, name: body.name, description: body.description, workerPrompt: body.workerPrompt, analysisPrompt: body.analysisPrompt, synthesisPrompt: body.synthesisPrompt };
    saveConfig({ ...(config as object), personas: [...(config.personas ?? []), persona] } as never);
    res.status(201).json(persona);
  });

  // PUT /:id: update a persona (works for builtins too — marks it user-overridden).
  // Special: PUT /:id with {reset: true} restores a builtin to its shipped default.
  r.put("/:id", (req, res) => {
    const id = req.params.id;
    const config = loadConfig();
    const list = [...(config.personas ?? [])];
    if (req.body?.reset === true) {
      const builtin = getBuiltin(id);
      if (!builtin) {
        res.status(404).json({ error: "NOT_A_BUILTIN", detail: `No builtin persona '${id}' to reset` });
        return;
      }
      // Replace any stored override with a fresh copy of the builtin.
      const without = list.filter((p) => p.id !== id);
      saveConfig({ ...(config as object), personas: [...without, { ...builtin }] } as never);
      res.json({ ...builtin });
      return;
    }
    const body = req.body ?? {};
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    const updated = {
      ...list[idx],
      ...(body.name ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.workerPrompt ? { workerPrompt: body.workerPrompt } : {}),
      ...(body.analysisPrompt ? { analysisPrompt: body.analysisPrompt } : {}),
      ...(body.synthesisPrompt ? { synthesisPrompt: body.synthesisPrompt } : {}),
    };
    list[idx] = updated;
    saveConfig({ ...(config as object), personas: list } as never);
    res.json(updated);
  });

  // DELETE /:id: remove a persona. Builtins can't be deleted (only reset);
  // the active persona can't be removed (reassign first).
  r.delete("/:id", (req, res) => {
    const id = req.params.id;
    const config = loadConfig();
    if (getBuiltin(id)) {
      res.status(400).json({ error: "CANNOT_DELETE_BUILTIN", detail: "Reset a builtin with PUT /:id {reset:true} instead." });
      return;
    }
    if ((config.settings.activePersona ?? DEFAULT_PERSONA_ID) === id) {
      res.status(400).json({ error: "CANNOT_DELETE_ACTIVE", detail: "Set a different active persona first." });
      return;
    }
    const list = (config.personas ?? []).filter((p) => p.id !== id);
    saveConfig({ ...(config as object), personas: list } as never);
    res.status(204).send();
  });

  return r;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "persona";
}
