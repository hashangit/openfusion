// GET /api/stats — aggregated dashboard KPIs + breakdowns (filters: from,to,model,status).
import { Router, type Request, type Response } from "express";
import type { DB } from "../../store/db.js";
import { kpis, costByModel, tokensByModel, fusionsByDay } from "../../store/stats.js";
import type { Filters } from "../../store/stats.js";

export function statsRouter(db: DB): Router {
  const r = Router();

  r.get("/", (req: Request, res: Response) => {
    const filters = parseFilters(req);
    res.json({
      kpis: kpis(db, filters),
      costByModel: costByModel(db, filters),
      tokensByModel: tokensByModel(db, filters),
      fusionsByDay: fusionsByDay(db, filters),
    });
  });

  return r;
}

export function parseFilters(req: Request): Filters {
  const { from, to, model, status } = req.query as Record<string, string | undefined>;
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(model ? { model } : {}),
    ...(status ? { status } : {}),
  };
}
