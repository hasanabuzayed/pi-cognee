import { join } from "node:path";
import { DEFAULT_PI_STATE_DIR } from "../constants";

/** pi-side state dir (~/.cognee-plugin/pi), override for tests/embedding. */
export function piStateDir(): string {
	return process.env.COGNEE_PI_STATE_DIR ?? DEFAULT_PI_STATE_DIR;
}

export function activeDatasetPath(): string {
	return join(piStateDir(), "active-dataset.json");
}
