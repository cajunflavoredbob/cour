import { useSelector } from "../store";
import { type CourSeason, servedSeason } from "../utils/season";

/**
 * The season every screen should label and theme by: the SERVER's served
 * season from the config frame (the single source of truth -- it rotates
 * one month ahead of the calendar changeover and can lag a failed
 * rotation fetch). The local servedSeason mirror only covers the beat
 * before the config frame arrives.
 */
export const useSeason = (): { season: CourSeason; year: number } => {
  // `?? {}`: component tests stub the store module with a bare vi.fn()
  // selector; the real useSelector always returns a picked object.
  const { config } = useSelector(["config"]) ?? {};
  if (config?.season && config.year != null) {
    return { season: config.season, year: config.year };
  }
  return servedSeason(new Date());
};
