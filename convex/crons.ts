import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("refresh NYC DOT camera catalog", { hours: 12 }, internal.nycCameras.refreshCatalog);
crons.interval("refresh SF Caltrans camera catalog", { hours: 6 }, internal.sfCameras.refreshCatalog);
export default crons;
