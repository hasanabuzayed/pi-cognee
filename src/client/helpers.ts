/** One compact human line for an UpdateResult: "+3/−1 chunks, 12 kept"
 *  (incremental), "no content change" (unchanged), or "memory dropped and
 *  rebuilt (fallback: <reason>)" — counters are null on a rebuild by contract. */
export function updateSummaryLine(data: Record<string, unknown>): string {
	const status = String(data.status ?? "");
	const num = (key: string): number | null => {
		const v = data[key];
		return typeof v === "number" && Number.isFinite(v) ? v : null;
	};
	const fallback = data.fallback;
	const reason =
		fallback &&
		typeof fallback === "object" &&
		typeof (fallback as { reason?: unknown }).reason === "string"
			? (fallback as { reason: string }).reason
			: "";
	if (status === "unchanged") return "no content change";
	if (status === "full_rebuild") {
		return `memory dropped and rebuilt${reason ? ` (fallback: ${reason})` : ""}`;
	}
	const parts: string[] = [];
	const added = num("added_chunks");
	const deleted = num("deleted_chunks");
	if (added !== null || deleted !== null)
		parts.push(`+${added ?? 0}/−${deleted ?? 0} chunks`);
	const kept = num("kept_chunks");
	if (kept !== null) parts.push(`${kept} kept`);
	const reused = num("reused_chunks");
	if (reused !== null && reused > 0) parts.push(`${reused} reused`);
	if (reason) parts.push(`fallback: ${reason}`);
	return parts.join(", ") || status;
}
