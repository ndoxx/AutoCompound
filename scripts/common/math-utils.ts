
export function clamp(
	a: number,
	min: number,
	max: number
) {
	return Math.max(min, Math.min(a, max));
}