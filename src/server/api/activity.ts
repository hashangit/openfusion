// GET /api/activity (paginated list) and /api/activity/:id (expandable detail).
import { Router, type Request, type Response } from "express";
import type { DB } from "../../store/db.js";
import { getActivity } from "../../store/activity.js";
import { listActivity, totalCount } from "../../store/stats.js";
import { parseFilters } from "./stats.js";

export function activityRouter(db: DB): Router {
  const r = Router();

  r.get("/", (req: Request, res: Response) => {
    const limit = clamp(parseInt(String(req.query.limit ?? "25"), 10) || 25, 1, 100);
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
    const filters = parseFilters(req);
    res.json({
      total: totalCount(db, filters),
      limit,
      offset,
      items: listActivity(db, { limit, offset, filters }),
    });
  });

  r.get("/:id", (req: Request, res: Response) => {
    const id = String(req.params.id);
    const act = getActivity(db, id);
    if (!act) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.json(act);
  });

  return r;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
